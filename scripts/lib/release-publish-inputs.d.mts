import type { NpmPublishPlan } from "./npm-publish-plan.mjs";

export type ReleaseNpmDecision = {
  packageName: string;
  packageVersion: string;
  plan: NpmPublishPlan;
  decision: "already-published" | "superseded" | "plan";
  route: "npm-readback" | "npm-mirror" | "npm-tag-repair" | null;
  supersededBy: string | null;
  bootstrap: boolean;
};

export type ReleasePublishInputs = {
  version?: 1;
  targetSha?: string;
  npmDistTag?: string;
  pluginSdkApiAcknowledgement: string;
  pluginSdkApiEvidenceDigest?: string;
  stableSoakWaiver: string;
  npmDecisions: ReleaseNpmDecision[] | undefined;
};

export function resolveReleasePublishInputs(
  manifest: unknown,
  overrides?: {
    pluginSdkApiAcknowledgement?: string;
    stableSoakWaiver?: string;
    currentStableSoakWaiver?: string;
    targetSha?: string;
    npmDistTag?: string;
  },
): ReleasePublishInputs;

export function createReleasePublishInputs(options: {
  manifest: unknown;
  npmManifest: unknown;
  stableSoakWaiver?: string;
}): Promise<ReleasePublishInputs>;
