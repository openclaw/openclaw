import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { asPositiveSafeInteger, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  type createCrabboxVersionResolver,
  supportsCrabboxWsl2,
} from "./crabbox-worker-doctor-runtime.js";
import {
  type CrabboxMachineShape,
  type CrabboxOperatingSystem,
  CRABBOX_ENROLLABLE_TARGETS,
  CRABBOX_OS_LABELS,
  listCrabboxMachineOptions,
  nonEmptyString,
  parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import { CRABBOX_MACHINE_CATALOG_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

type CrabboxCatalog = {
  operatingSystems: CrabboxOperatingSystem[];
  machines: CrabboxMachineShape[];
};
type CrabboxMachineShapes = ReadonlyMap<string, CrabboxCatalog>;

type CrabboxMachineOptionsResolverDependencies = {
  resolveBinary: (explicit?: string) => string;
  runCommand: CrabboxCommandRunner;
  resolveVersion: ReturnType<typeof createCrabboxVersionResolver>;
  warn: (message: string) => void;
};

function parseCrabboxMachineShapes(stdout: string): CrabboxMachineShapes {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("Crabbox providers returned invalid JSON");
  }
  return new Map(
    parsed.flatMap<[string, CrabboxCatalog]>((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const provider = nonEmptyString(entry.provider)?.toLowerCase();
      if (!provider) {
        return [];
      }
      const targets = Array.isArray(entry.targets) ? entry.targets : [];
      const operatingSystems = CRABBOX_ENROLLABLE_TARGETS.filter((os) => targets.includes(os));
      const profiles =
        isRecord(entry.classCatalog) &&
        entry.classCatalog.disposition === "mapped" &&
        Array.isArray(entry.classCatalog.profiles)
          ? entry.classCatalog.profiles.filter(isRecord)
          : [];
      const machines = operatingSystems.flatMap<CrabboxMachineShape>((os) => {
        const [target, windowsMode] = os.split("/");
        const matching = profiles.filter(
          (raw) =>
            raw.target === target && (windowsMode === undefined || raw.windowsMode === windowsMode),
        );
        const amd64 = matching.some((raw) => raw.architecture === "amd64");
        return matching.flatMap<CrabboxMachineShape>((raw) => {
          if ((amd64 && raw.architecture !== "amd64") || !isRecord(raw.primary)) {
            return [];
          }
          const machineClass = nonEmptyString(raw.class);
          if (!machineClass) {
            return [];
          }
          const cpu = asPositiveSafeInteger(raw.primary.vcpu);
          const memory = raw.primary.memory;
          // Crabbox's integer memoryGb summary accepts GB/GiB only, without rounding.
          const memoryGb =
            isRecord(memory) && (memory.unit === "GB" || memory.unit === "GiB")
              ? asPositiveSafeInteger(memory.value)
              : undefined;
          return [
            { class: machineClass, os, ...(cpu ? { cpu } : {}), ...(memoryGb ? { memoryGb } : {}) },
          ];
        });
      });
      return [[provider, { operatingSystems, machines }]];
    }),
  );
}

export function createCrabboxMachineOptionsResolver(
  dependencies: CrabboxMachineOptionsResolverDependencies,
): Required<Pick<WorkerProvider, "listMachineOptions" | "listOperatingSystems">> {
  const machineShapesByBinary = new Map<string, Promise<CrabboxMachineShapes>>();
  const loadMachineShapes = async (binary: string): Promise<CrabboxMachineShapes> => {
    // The full provider matrix exceeds the lifecycle command's 64 KiB log cap.
    // Keep catalog JSON intact or every provider loses its machine shapes.
    const result = await dependencies.runCommand([binary, "providers", "--json"], {
      maxOutputBytes: 1024 * 1024,
      killProcessTree: true,
      timeoutMs: CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error(
        `Crabbox providers command failed (${result.termination}, code ${result.code})`,
      );
    }
    return parseCrabboxMachineShapes(result.stdout);
  };

  const resolveCatalog = async (profile: WorkerProfile) => {
    const parsed = parseCrabboxProfile(profile);
    const binary = dependencies.resolveBinary(parsed.binary);
    // Cache successful metadata per binary; different builds may advertise different sizes.
    // One rejection handler per load runs after insertion, including synchronous runner throws.
    let shapes = machineShapesByBinary.get(binary);
    if (!shapes) {
      shapes = loadMachineShapes(binary).catch((error: unknown) => {
        machineShapesByBinary.delete(binary);
        dependencies.warn(
          `Crabbox machine shapes unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new Map();
      });
      machineShapesByBinary.set(binary, shapes);
    }
    const catalog = (await shapes).get(parsed.provider);
    if (catalog?.operatingSystems.includes("windows/wsl2")) {
      const version = await dependencies.resolveVersion(binary);
      if (version.status === "indeterminate" || !supportsCrabboxWsl2(version.version)) {
        return {
          parsed,
          catalog: {
            operatingSystems: catalog.operatingSystems.filter((os) => os !== "windows/wsl2"),
            machines: catalog.machines.filter((machine) => machine.os !== "windows/wsl2"),
          },
        };
      }
    }
    return { parsed, catalog };
  };
  return {
    async listMachineOptions(profile) {
      const { parsed, catalog } = await resolveCatalog(profile);
      return listCrabboxMachineOptions(parsed.class, catalog?.machines);
    },
    async listOperatingSystems(profile) {
      const { parsed, catalog } = await resolveCatalog(profile);
      return (catalog?.operatingSystems ?? []).map((id) => {
        const label = CRABBOX_OS_LABELS[id];
        return id === parsed.target ? { id, label, default: true } : { id, label };
      });
    },
  };
}
