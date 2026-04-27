import fs from "node:fs";
import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState, } from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
const log = createSubsystemLogger("embedded-pi-settings");
export const DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY = "sanitize";
export const SANITIZED_PROJECT_PI_KEYS = ["shellPath", "shellCommandPrefix"];
function sanitizePiSettingsSnapshot(settings) {
    const sanitized = { ...settings };
    // Never allow plugin or workspace-local settings to override shell execution behavior.
    for (const key of SANITIZED_PROJECT_PI_KEYS) {
        delete sanitized[key];
    }
    return sanitized;
}
function sanitizeProjectSettings(settings) {
    return sanitizePiSettingsSnapshot(settings);
}
function loadBundleSettingsFile(params) {
    const absolutePath = path.join(params.rootDir, params.relativePath);
    const opened = openBoundaryFileSync({
        absolutePath,
        rootPath: params.rootDir,
        boundaryLabel: "plugin root",
        rejectHardlinks: true,
    });
    if (!opened.ok) {
        log.warn(`skipping unsafe bundle settings file: ${absolutePath}`);
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8"));
        if (!isRecord(raw)) {
            log.warn(`skipping bundle settings file with non-object JSON: ${absolutePath}`);
            return null;
        }
        return sanitizePiSettingsSnapshot(raw);
    }
    catch (error) {
        log.warn(`failed to parse bundle settings file ${absolutePath}: ${String(error)}`);
        return null;
    }
    finally {
        fs.closeSync(opened.fd);
    }
}
export function loadEnabledBundlePiSettingsSnapshot(params) {
    const workspaceDir = params.cwd.trim();
    if (!workspaceDir) {
        return {};
    }
    const registry = loadPluginManifestRegistry({
        workspaceDir,
        config: params.cfg,
    });
    if (registry.plugins.length === 0) {
        return {};
    }
    const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
    let snapshot = {};
    for (const record of registry.plugins) {
        const settingsFiles = record.settingsFiles ?? [];
        if (record.format !== "bundle" || settingsFiles.length === 0) {
            continue;
        }
        const activationState = resolveEffectivePluginActivationState({
            id: record.id,
            origin: record.origin,
            config: normalizedPlugins,
            rootConfig: params.cfg,
        });
        if (!activationState.activated) {
            continue;
        }
        for (const relativePath of settingsFiles) {
            const bundleSettings = loadBundleSettingsFile({
                rootDir: record.rootDir,
                relativePath,
            });
            if (!bundleSettings) {
                continue;
            }
            snapshot = applyMergePatch(snapshot, bundleSettings);
        }
    }
    const embeddedPiMcp = loadEmbeddedPiMcpConfig({
        workspaceDir,
        cfg: params.cfg,
    });
    for (const diagnostic of embeddedPiMcp.diagnostics) {
        log.warn(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
    if (Object.keys(embeddedPiMcp.mcpServers).length > 0) {
        snapshot = applyMergePatch(snapshot, {
            mcpServers: embeddedPiMcp.mcpServers,
        });
    }
    return snapshot;
}
export function resolveEmbeddedPiProjectSettingsPolicy(cfg) {
    const raw = cfg?.agents?.defaults?.embeddedPi?.projectSettingsPolicy;
    if (raw === "trusted" || raw === "sanitize" || raw === "ignore") {
        return raw;
    }
    return DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY;
}
export function buildEmbeddedPiSettingsSnapshot(params) {
    const effectiveProjectSettings = params.policy === "ignore"
        ? {}
        : params.policy === "sanitize"
            ? sanitizeProjectSettings(params.projectSettings)
            : params.projectSettings;
    const withPluginSettings = applyMergePatch(params.globalSettings, sanitizePiSettingsSnapshot(params.pluginSettings ?? {}));
    return applyMergePatch(withPluginSettings, effectiveProjectSettings);
}
