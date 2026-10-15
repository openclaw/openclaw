import type {
  SuggestedWorkerProfile,
  WorkerProfileSuggestionDiscovery,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findCrabboxBinary } from "./crabbox-binary.js";
import { runCrabboxProcess } from "./crabbox-process.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createCrabboxMachineCatalogResolver } from "./crabbox-worker-machine-options.js";
import { loadCrabboxConfigShow } from "./crabbox-worker-preflight.js";

const STANDARD_CLASSES = ["tiny", "small", "standard", "fast", "large", "beast"];

export function createCrabboxProfileSuggestionDiscovery(dependencies: {
  findBinary?: () => string | undefined;
  runCommand?: CrabboxCommandRunner;
  warn: (message: string) => void;
}): WorkerProfileSuggestionDiscovery {
  const runCommand = dependencies.runCommand ?? runCrabboxProcess;
  let cached: Promise<SuggestedWorkerProfile | undefined> | undefined;

  const discover = async (): Promise<SuggestedWorkerProfile | undefined> => {
    const binary = dependencies.findBinary
      ? dependencies.findBinary()
      : findCrabboxBinary({ pathEnv: process.env.PATH });
    if (!binary) {
      return undefined;
    }
    const config = await loadCrabboxConfigShow({ binary, runCommand });
    if (!isRecord(config) || config.providerSelected !== true) {
      return undefined;
    }
    const provider = normalizeOptionalString(config.provider)?.toLowerCase();
    if (!provider) {
      return undefined;
    }
    const coordinator = normalizeOptionalString(config.coordinator);
    if (coordinator) {
      if (config.brokerAuth !== "configured" && config.brokerAuth !== "command") {
        return undefined;
      }
    } else {
      const statuses = isRecord(config.providerStatus)
        ? config.providerStatus.providers
        : undefined;
      const selected = isRecord(statuses) ? statuses[provider] : undefined;
      const configuration = isRecord(selected) ? selected.configuration : undefined;
      // Crabbox records accepted configuration inputs; allocation owns live authentication checks.
      if (!isRecord(configuration) || configuration.state !== "explicit") {
        return undefined;
      }
    }
    const catalog = await createCrabboxMachineCatalogResolver({
      resolveBinary: async () => binary,
      runCommand,
      warn: dependencies.warn,
    })(provider);
    const machineClass = STANDARD_CLASSES.find((candidate) =>
      catalog?.machines.some((machine) => machine.os === "linux" && machine.class === candidate),
    );
    if (!machineClass) {
      return undefined;
    }
    return {
      id: "cloud",
      providerDisplayId: provider,
      profile: {
        provider: "crabbox",
        install: "bundle",
        suspendAfter: "45m",
        settings: {
          provider,
          target: "linux",
          class: machineClass,
          ttl: "4h",
          idleTimeout: "45m",
          warmImage: true,
        },
      },
    };
  };

  return ({ refresh }) => {
    if (refresh || !cached) {
      cached = discover().catch((error: unknown) => {
        dependencies.warn(`Crabbox profile discovery unavailable: ${String(error)}`);
        return undefined;
      });
    }
    return cached;
  };
}
