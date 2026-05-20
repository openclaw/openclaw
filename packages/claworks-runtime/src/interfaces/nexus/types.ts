/** ClaWorks Nexus registry API (ClawHub-compatible subset). */

export type NexusPackageSummary = {
  slug: string;
  name: string;
  description?: string;
  latestVersion?: string;
  family?: string;
};

export type NexusPackageDetail = NexusPackageSummary & {
  versions: string[];
};

export type NexusVersionDetail = {
  slug: string;
  version: string;
  manifest?: Record<string, unknown>;
};

export type NexusPackageListResponse = {
  packages: NexusPackageSummary[];
};

export type NexusArtifactDescriptor = {
  slug: string;
  version: string;
  hostKey: string;
  mediaType: string;
  size?: number;
};
