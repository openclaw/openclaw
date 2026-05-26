import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
export type PostInstallMigrationOptions = {
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    prompter?: WizardPrompter;
    installedPluginIds: readonly string[];
    nonInteractive?: boolean;
};
export type PostInstallMigrationResult = {
    config: OpenClawConfig;
};
/**
 * Offer interactive migration for any migration provider owned by a plugin
 * that was just installed during onboarding. In non-interactive mode this is
 * a no-op apart from a hint line so scripted setups never mutate state
 * unexpectedly. The actual migration UI (skill/plugin checkboxes, confirm
 * prompt) is owned by `openclaw migrate <provider>`; this helper only owns
 * the gate prompt.
 */
export declare function offerPostInstallMigrations(params: PostInstallMigrationOptions): Promise<PostInstallMigrationResult>;
