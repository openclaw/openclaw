import type { Skill } from "@mariozechner/pi-coding-agent";
import type { OpenClawSkillMetadata, ParsedSkillFrontmatter, SkillEntry, SkillInvocationPolicy } from "./types.js";
export declare function parseFrontmatter(content: string): ParsedSkillFrontmatter;
export declare function resolveOpenClawMetadata(frontmatter: ParsedSkillFrontmatter): OpenClawSkillMetadata | undefined;
export declare function resolveSkillInvocationPolicy(frontmatter: ParsedSkillFrontmatter): SkillInvocationPolicy;
export declare function resolveSkillKey(skill: Skill, entry?: SkillEntry): string;
