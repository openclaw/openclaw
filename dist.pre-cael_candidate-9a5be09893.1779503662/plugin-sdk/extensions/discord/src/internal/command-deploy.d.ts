import { type APIApplicationCommand } from "discord-api-types/v10";
import type { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";
export type DeployCommandOptions = {
    mode?: "overwrite" | "reconcile";
    force?: boolean;
};
export declare class DiscordCommandDeployer {
    private readonly params;
    private readonly hashes;
    private hashesLoaded;
    constructor(params: {
        clientId: string;
        commands: BaseCommand[];
        devGuilds?: string[];
        hashStorePath?: string;
        rest: () => RequestClient;
    });
    getCommands(): Promise<APIApplicationCommand[]>;
    deploy(options?: DeployCommandOptions): Promise<{
        mode: "overwrite" | "reconcile";
        usedDevGuilds: boolean;
    }>;
    private reconcileGlobalCommands;
    private putCommandSetIfChanged;
    private loadPersistedHashes;
    private persistHashes;
    private get rest();
}
declare function comparableCommand(value: unknown): unknown;
/**
 * Normalize a Discord command description for equality comparison.
 *
 * Discord's server-side storage performs two transformations that our local
 * desired descriptors do not:
 *
 * 1. Consecutive whitespace (including `\n`) is collapsed to a single space.
 * 2. Whitespace between two CJK (Chinese, Japanese, Korean) characters is
 *    removed entirely. So a local description `"第一行。\n第二行。"` is stored
 *    as `"第一行。第二行。"` on Discord and returned without the `\n`.
 *
 * Without this normalization every startup for any CJK-heavy deployment reads
 * back Discord's collapsed form, computes a diff against the local `\n`-form,
 * decides the command needs updating, and issues a `PATCH`. Under the global
 * per-application rate limit this quickly produces 429 bursts and some
 * commands silently fail to register (see the Discord deploy 429 reports).
 *
 * Applying the same transformation to both sides before comparison makes the
 * equality check match Discord's storage semantics and prevents spurious
 * reconcile writes on every startup.
 */
declare function normalizeDescriptionForComparison(description: string): string;
declare function commandsEqual(a: unknown, b: unknown): boolean;
export declare const testing: {
    readonly commandsEqual: typeof commandsEqual;
    readonly comparableCommand: typeof comparableCommand;
    readonly normalizeDescriptionForComparison: typeof normalizeDescriptionForComparison;
};
export { testing as __testing };
