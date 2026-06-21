// Gateway Protocol schema for image generation provider inventory.
import { Type } from "typebox";

/**
 * Image generation provider capabilities.
 */
export const ImageProviderCapabilitySupportSchema = Type.Object({
  maxCount: Type.Optional(Type.Number()),
  supportsSize: Type.Optional(Type.Boolean()),
  supportsAspectRatio: Type.Optional(Type.Boolean()),
  supportsResolution: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
});

export const ImageProviderCapabilityGeometrySchema = Type.Union([
  Type.Boolean(),
  Type.Object({
    sizes: Type.Optional(Type.Array(Type.String())),
    sizesByModel: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    aspectRatios: Type.Optional(Type.Array(Type.String())),
    resolutions: Type.Optional(Type.Array(Type.String())),
  }),
]);

export const ImageProviderCapabilityOutputSchema = Type.Union([
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
  generate: Type.Union([Type.Boolean(), ImageProviderCapabilitySupportSchema]),
  edit: Type.Union([Type.Boolean(), ImageProviderCapabilitySupportSchema]),
  geometry: ImageProviderCapabilityGeometrySchema,
  output: ImageProviderCapabilityOutputSchema,
});

/**
 * Single image generation provider entry.
 */
export const ImageProviderSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  configured: Type.Boolean(),
  defaultModel: Type.Optional(Type.String()),
  models: Type.Array(Type.String()),
  capabilities: ImageProviderCapabilitiesSchema,
});

/**
 * Result of image.providers RPC call.
 */
export const ImageProvidersResultSchema = Type.Object({
  providers: Type.Array(ImageProviderSchema),
  active: Type.Union([Type.String(), Type.Null()]),
});

export type ImageProviderCapabilitySupport = {
  maxCount?: number;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  enabled?: boolean;
};

export type ImageProviderCapabilityGeometry =
  | boolean
  | {
      sizes?: string[];
      sizesByModel?: Record<string, string[]>;
      aspectRatios?: string[];
      resolutions?: string[];
    };

export type ImageProviderCapabilityOutput =
  | boolean
  | {
      formats?: string[];
      qualities?: string[];
      backgrounds?: string[];
    };

export type ImageProviderCapabilities = {
  generate: boolean | ImageProviderCapabilitySupport;
  edit: boolean | ImageProviderCapabilitySupport;
  geometry: ImageProviderCapabilityGeometry;
  output: ImageProviderCapabilityOutput;
};

export type ImageProvider = {
  id: string;
  label: string;
  configured: boolean;
  defaultModel?: string;
  models: string[];
  capabilities: ImageProviderCapabilities;
};

export type ImageProvidersResult = {
  providers: ImageProvider[];
  active: string | null;
};
