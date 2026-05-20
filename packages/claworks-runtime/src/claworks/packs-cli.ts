import type { Command } from "commander";
import { listNexusPackages, parseNexusSource } from "../pack-loader/index.js";
import {
  installClaworksPack,
  loadPersistedInstalled,
  reloadClaworksPacksFromDisk,
  resolveInstalledStatePath,
} from "./pack-runtime.js";
import { isClaworksProduct } from "./product-env.js";
import { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } from "./runtime.js";

export function registerClaworksPacksCli(program: Command): void {
  if (!isClaworksProduct()) {
    return;
  }

  const packs = program
    .command("packs")
    .description("Manage ClaWorks extension packs (Nexus registry)");

  packs
    .command("list")
    .description("List installed packs")
    .action(async () => {
      const installed = await loadPersistedInstalled();
      console.log(JSON.stringify({ installed, state: resolveInstalledStatePath() }, null, 2));
    });

  packs
    .command("search")
    .argument("[query]", "search query")
    .option("--registry <url>", "Nexus registry URL", "http://127.0.0.1:8080")
    .action(async (query: string | undefined, opts: { registry: string }) => {
      const result = await listNexusPackages(opts.registry, { q: query });
      console.log(JSON.stringify(result, null, 2));
    });

  packs
    .command("update")
    .argument("<source>", "nexus://pack@version or pack name")
    .option("--registry <url>", "Nexus registry URL")
    .description("Update (re-install) a pack from Nexus or local path")
    .action(async (source: string, opts: { registry?: string }) => {
      const runtime = await createClaworksRuntime({
        packs: {
          registry: opts.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080",
          installed: await loadPersistedInstalled(),
        },
      });
      await startClaworksRuntime(runtime);
      try {
        const nexusSource = source.startsWith("nexus://") ? source : `nexus://${source}`;
        const result = await installClaworksPack(runtime, nexusSource);
        console.log(
          JSON.stringify(
            {
              updated: result.pack.manifest.id,
              version: result.pack.manifest.version,
              installed: result.installed,
            },
            null,
            2,
          ),
        );
      } finally {
        await stopClaworksRuntime(runtime);
      }
    });

  packs
    .command("reload")
    .description("Reload packs from disk without installing")
    .action(async () => {
      const runtime = await createClaworksRuntime({
        packs: { installed: await loadPersistedInstalled() },
      });
      await startClaworksRuntime(runtime);
      try {
        const result = await reloadClaworksPacksFromDisk(runtime);
        console.log(JSON.stringify({ reloaded: result.packs.map((p) => p.manifest.id) }, null, 2));
      } finally {
        await stopClaworksRuntime(runtime);
      }
    });

  packs
    .command("install")
    .argument("<source>", "nexus://pack@version or pack name")
    .option("--registry <url>", "Nexus registry URL")
    .action(async (source: string, opts: { registry?: string }) => {
      const runtime = await createClaworksRuntime({
        packs: {
          registry: opts.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080",
          installed: await loadPersistedInstalled(),
        },
      });
      await startClaworksRuntime(runtime);
      try {
        const nexusSource = source.startsWith("nexus://") ? source : `nexus://${source}`;
        if (!parseNexusSource(nexusSource) && !source.startsWith("file://")) {
          throw new Error(`Invalid pack source: ${source}`);
        }
        const result = await installClaworksPack(runtime, nexusSource);
        console.log(
          JSON.stringify(
            {
              pack: result.pack.manifest.id,
              version: result.pack.manifest.version,
              path: result.pack.path,
              installed: result.installed,
            },
            null,
            2,
          ),
        );
      } finally {
        await stopClaworksRuntime(runtime);
      }
    });
}
