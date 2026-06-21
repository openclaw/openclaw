// Gateway Protocol schema for image generation provider inventory.
// Compliant with src/image-generation/types.ts ImageGenerationProviderCapabilities contract.
import { Type } from "typebox";

/**
 * Image generation provider mode capabilities (generate/edit).
 */
export const ImageProviderModeCapabilitySchema = Type.Object({
  maxCount: Type.Optional(Type.Number()),
  supportsSize: Type.Optional(Type.Boolean()),
  supportsAspectRatio: Type.Optional(Type.Boolean()),
  supportsResolution: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
});

/**
 * Image generation provider edit capabilities.
 */
export const ImageProviderEditCapabilitySchema = Type.Object({
  maxCount: Type.Optional(Type.Number()),
  supportsSize: Type.Optional(Type.Boolean()),
  supportsAspectRatio: Type.Optional(Type.Boolean()),
  supportsResolution: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
  maxInputImages: Type.Optional(Type.Number()), // Finding 5: missing field
});

/**
 * Image generation provider geometry capabilities.
 */
export const ImageProviderGeometryCapabilitySchema = Type.Union([
  Type.Boolean(),
  Type.Object({
    sizes: Type.Optional(Type.Array(Type.String())),
    sizesByModel: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    aspectRatios: Type.Optional(Type.Array(Type.String())),
    aspectRatiosByModel: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))), // Finding 5: missing field
    resolutions: Type.Optional(Type.Array(Type.String())),
    resolutionsByModel: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))), // Finding 5: missing field
  }),
]);

/**
 * Image generation provider output capabilities.
 */
export const ImageProviderOutputCapabilitySchema = Type.Union([
  Type.Boolean(),
  Type.Array(Type.String()), // Empty array [] is valid
  Type.Object({
    formats: Type.Optional(Type.Array(Type.String())),
    qualities: Type.Optional(Type.Array(Type.String())),
    backgrounds: Type.Optional(Type.Array(Type.String())),
  }),
]);

/**
 * Image generation provider capabilities.
 */
export const ImageProviderCapabilitiesSchema = Type.Object({
  generate: ImageProviderModeCapabilitySchema,
  edit: ImageProviderEditCapabilitySchema,
  geometry: ImageProviderGeometryCapabilitySchema,
  output: ImageProviderOutputCapabilitySchema,
});

/**
 * Single image generation provider entry.
 */
export const ImageProviderSchema = Type.Object({
  id: Type.String(),
  label: Type.Optional(Type.String()),
  configured: Type.Boolean(),
  defaultModel: Type.Optional(Type.String()),
  models: Type.Optional(Type.Array(Type.String())),
  capabilities: ImageProviderCapabilitiesSchema,
});

/**
 * Result of image.providers RPC call.
 */
export const ImageProvidersResultSchema = Type.Object({
  providers: Type.Array(ImageProviderSchema),
  active: Type.Union([Type.String(), Type.Null()]),
});

// Type exports
export type ImageProviderModeCapability = {
  maxCount?: number;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  enabled?: boolean;
};

export type ImageProviderEditCapability = ImageProviderModeCapability & {
  maxInputImages?: number;
};

export type ImageProviderGeometryCapability =
  | boolean
  | {
      sizes?: string[];
      sizesByModel?: Record<string, string[]>;
      aspectRatios?: string[];
      aspectRatiosByModel?: Record<string, string[]>;
      resolutions?: string[];
      resolutionsByModel?: Record<string, string[]>;
    };

export type ImageProviderOutputCapability =
  | boolean
  | {
      formats?: string[];
      qualities?: string[];
      backgrounds?: string[];
    };

export type ImageProviderCapabilities = {
  generate: ImageProviderModeCapability;
  edit: ImageProviderEditCapability;
  geometry?: ImageProviderGeometryCapability;
  output?: ImageProviderOutputCapability;
};

export type ImageProvider = {
  id: string;
  label?: string;
  configured: boolean;
  defaultModel?: string;
  models?: string[];
  capabilities: ImageProviderCapabilities;
};

export type ImageProvidersResult = {
  providers: ImageProvider[];
  active: string | null;
};
