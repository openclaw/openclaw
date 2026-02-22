import fs from "fs";
import path from "path";

export interface CommunityUsecase {
  id: string;
  slug: string;
  title: string;
  category: string;
  tags: string[];
  rating: number;
  summary: string;
  content: string;
  source: string;
  sourceDetail: string;
  sourcePath: string;
  url?: string;
}

export interface CommunitySkill {
  id: string;
  slug: string;
  name: string;
  description?: string;
  category: string;
  tags: string[];
  source: string;
  sourcePath: string;
  url?: string;
  scriptsCount: number;
  referencesCount: number;
}

interface UsecaseCatalogFile {
  generatedAt: string;
  sourceZips?: string[];
  total: number;
  usecases: CommunityUsecase[];
}

interface SkillsCatalogFile {
  generatedAt: string;
  sourceZips?: string[];
  total: number;
  skills: CommunitySkill[];
}

const CATALOG_DIR = path.join(process.cwd(), "src", "community-catalog");
const USECASES_FILE = path.join(CATALOG_DIR, "usecases.json");
const SKILLS_FILE = path.join(CATALOG_DIR, "skills.json");
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CommunityCatalogCache {
  expiresAt: number;
  usecases: UsecaseCatalogFile;
  skills: SkillsCatalogFile;
}

let cache: CommunityCatalogCache | null = null;

function defaultUsecases(): UsecaseCatalogFile {
  return {
    generatedAt: new Date(0).toISOString(),
    sourceZips: [],
    total: 0,
    usecases: [],
  };
}

function defaultSkills(): SkillsCatalogFile {
  return {
    generatedAt: new Date(0).toISOString(),
    sourceZips: [],
    total: 0,
    skills: [],
  };
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {return null;}
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isUsecaseCatalog(value: unknown): value is UsecaseCatalogFile {
  if (!value || typeof value !== "object") {return false;}
  const maybe = value as Partial<UsecaseCatalogFile>;
  return (
    typeof maybe.generatedAt === "string" &&
    typeof maybe.total === "number" &&
    Array.isArray(maybe.usecases)
  );
}

function isSkillsCatalog(value: unknown): value is SkillsCatalogFile {
  if (!value || typeof value !== "object") {return false;}
  const maybe = value as Partial<SkillsCatalogFile>;
  return (
    typeof maybe.generatedAt === "string" &&
    typeof maybe.total === "number" &&
    Array.isArray(maybe.skills)
  );
}

function loadCatalogs(): CommunityCatalogCache {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache;
  }

  const rawUsecases = safeReadJson<unknown>(USECASES_FILE);
  const rawSkills = safeReadJson<unknown>(SKILLS_FILE);

  const usecases = isUsecaseCatalog(rawUsecases) ? rawUsecases : defaultUsecases();
  const skills = isSkillsCatalog(rawSkills) ? rawSkills : defaultSkills();

  cache = {
    expiresAt: now + CACHE_TTL_MS,
    usecases,
    skills,
  };
  return cache;
}

export function getCommunityUsecaseCatalog(): UsecaseCatalogFile {
  return loadCatalogs().usecases;
}

export function getCommunitySkillsCatalog(): SkillsCatalogFile {
  return loadCatalogs().skills;
}
