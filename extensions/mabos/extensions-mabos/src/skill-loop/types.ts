export interface SkillLoopConfig {
  skillLoopEnabled?: boolean;
  skillPaths?: string[];
  creationNudgeInterval?: number;
  autoInstall?: boolean;
  marketplace?: {
    enabled?: boolean;
    sources?: Array<{ name: string; type: "github" | "clawhub" | "local"; url?: string }>;
  };
  maxSkillsInPrompt?: number;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  toolsRequired?: string[];
  applicableRoles?: string[];
  createdFromSession?: string;
  createdAt: string;
  confidence?: number;
}

export interface SkillEntry {
  name: string;
  path: string;
  manifest: SkillManifest;
  content: string;
}

export interface SkillProposal {
  name: string;
  skillMd: string;
  manifest: SkillManifest;
  confidence: number;
}
