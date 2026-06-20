// Gateway Protocol schema for image generation provider inventory.
import { Type } from "typebox";

/**
 * Image generation provider capabilities.
 */
export const ImageProviderCapabilitiesSchema = Type.Object({
  generate: Type.Optional(Type.Boolean()),
  edit: Type.Optional(Type.Boolean()),
  geometry: Type.Optional(Type.Union([Type.Boolean(), Type.Object({})])),
  output: Type.Optional(Type.Array(Type.Unknown())),
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
  active: Type.Optional(Type.String()),
});

export type ImageProvider = {
  id: string;
  label: string;
  configured: boolean;
  defaultModel?: string;
  models: string[];
  capabilities: {
    generate?: boolean;
    edit?: boolean;
    geometry?: boolean | Record<string, unknown>;
    output?: unknown[];
  };
};

export type ImageProvidersResult = {
  providers: ImageProvider[];
  active?: string;
};
