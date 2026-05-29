//#region src/normalization.d.ts
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
declare function hasMediaNormalizationEntry<TValue extends MediaNormalizationValue>(entry: MediaNormalizationEntry<TValue> | undefined): entry is MediaNormalizationEntry<TValue>;
//#endregion
export { MediaGenerationNormalizationMetadataInput, MediaNormalizationEntry, MediaNormalizationValue, hasMediaNormalizationEntry };