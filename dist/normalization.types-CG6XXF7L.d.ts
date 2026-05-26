//#region src/media-generation/normalization.types.d.ts
type MediaNormalizationValue = string | number | boolean;
type MediaNormalizationEntry<TValue extends MediaNormalizationValue> = {
  requested?: TValue;
  applied?: TValue;
  derivedFrom?: string;
  supportedValues?: readonly TValue[];
};
type MediaGenerationNormalizationMetadataInput = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<string>;
  durationSeconds?: MediaNormalizationEntry<number>;
};
//#endregion
export { MediaNormalizationEntry as n, MediaNormalizationValue as r, MediaGenerationNormalizationMetadataInput as t };