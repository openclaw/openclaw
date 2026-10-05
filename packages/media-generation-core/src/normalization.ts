/** Primitive value types reported in media generation normalization metadata. */
export type MediaNormalizationValue = string | number | boolean;

/** Requested/applied value pair plus provenance for a normalized media option. */
export type MediaNormalizationEntry<TValue extends MediaNormalizationValue> = {
  requested?: TValue;
  applied?: TValue;
  derivedFrom?: string;
  supportedValues?: readonly TValue[];
};

/** Normalization metadata shared by media generation responses. */
export type MediaGenerationNormalizationMetadataInput = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<string>;
  durationSeconds?: MediaNormalizationEntry<number>;
};
