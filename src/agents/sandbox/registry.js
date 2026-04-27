import fs from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../../infra/json-files.js";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { SANDBOX_BROWSER_REGISTRY_PATH, SANDBOX_REGISTRY_PATH } from "./constants.js";
const RegistryEntrySchema = z
    .object({
    containerName: z.string(),
})
    .passthrough();
const RegistryFileSchema = z.object({
    entries: z.array(RegistryEntrySchema),
});
function normalizeSandboxRegistryEntry(entry) {
    return {
        ...entry,
        backendId: entry.backendId?.trim() || "docker",
        runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
        configLabelKind: entry.configLabelKind?.trim() || "Image",
    };
}
async function withRegistryLock(registryPath, fn) {
    const lock = await acquireSessionWriteLock({
        sessionFile: registryPath,
        allowReentrant: false,
        timeoutMs: 60_000,
    });
    try {
        return await fn();
    }
    finally {
        await lock.release();
    }
}
async function readRegistryFromFile(registryPath, mode) {
    try {
        const raw = await fs.readFile(registryPath, "utf-8");
        const parsed = safeParseJsonWithSchema(RegistryFileSchema, raw);
        if (parsed) {
            return parsed;
        }
        if (mode === "fallback") {
            return { entries: [] };
        }
        throw new Error(`Invalid sandbox registry format: ${registryPath}`);
    }
    catch (error) {
        const code = error?.code;
        if (code === "ENOENT") {
            return { entries: [] };
        }
        if (mode === "fallback") {
            return { entries: [] };
        }
        if (error instanceof Error) {
            throw error;
        }
        throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
    }
}
async function writeRegistryFile(registryPath, registry) {
    await writeJsonAtomic(registryPath, registry, { trailingNewline: true });
}
export async function readRegistry() {
    const registry = await readRegistryFromFile(SANDBOX_REGISTRY_PATH, "fallback");
    return {
        entries: registry.entries.map((entry) => normalizeSandboxRegistryEntry(entry)),
    };
}
function upsertEntry(entries, entry) {
    const existing = entries.find((item) => item.containerName === entry.containerName);
    const next = entries.filter((item) => item.containerName !== entry.containerName);
    next.push({
        ...entry,
        backendId: entry.backendId ?? existing?.backendId,
        runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
        createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
        image: existing?.image ?? entry.image,
        configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
        configHash: entry.configHash ?? existing?.configHash,
    });
    return next;
}
function removeEntry(entries, containerName) {
    return entries.filter((entry) => entry.containerName !== containerName);
}
async function withRegistryMutation(registryPath, mutate) {
    await withRegistryLock(registryPath, async () => {
        const registry = await readRegistryFromFile(registryPath, "strict");
        const next = mutate(registry.entries);
        if (next === null) {
            return;
        }
        await writeRegistryFile(registryPath, { entries: next });
    });
}
export async function updateRegistry(entry) {
    await withRegistryMutation(SANDBOX_REGISTRY_PATH, (entries) => upsertEntry(entries, entry));
}
export async function removeRegistryEntry(containerName) {
    await withRegistryMutation(SANDBOX_REGISTRY_PATH, (entries) => {
        const next = removeEntry(entries, containerName);
        if (next.length === entries.length) {
            return null;
        }
        return next;
    });
}
export async function readBrowserRegistry() {
    return await readRegistryFromFile(SANDBOX_BROWSER_REGISTRY_PATH, "fallback");
}
export async function updateBrowserRegistry(entry) {
    await withRegistryMutation(SANDBOX_BROWSER_REGISTRY_PATH, (entries) => upsertEntry(entries, entry));
}
export async function removeBrowserRegistryEntry(containerName) {
    await withRegistryMutation(SANDBOX_BROWSER_REGISTRY_PATH, (entries) => {
        const next = removeEntry(entries, containerName);
        if (next.length === entries.length) {
            return null;
        }
        return next;
    });
}
