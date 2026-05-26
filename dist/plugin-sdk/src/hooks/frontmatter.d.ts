import type { OpenClawHookMetadata, HookEntry, HookInvocationPolicy, ParsedHookFrontmatter } from "./types.js";
export declare function parseFrontmatter(content: string): ParsedHookFrontmatter;
export declare function resolveOpenClawMetadata(frontmatter: ParsedHookFrontmatter): OpenClawHookMetadata | undefined;
export declare function resolveHookInvocationPolicy(frontmatter: ParsedHookFrontmatter): HookInvocationPolicy;
export declare function resolveHookKey(hookName: string, entry?: HookEntry): string;
