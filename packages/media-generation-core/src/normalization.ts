import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type MediaNormalizationValue = string | number | boolean;

export type MediaNormalizationEntry<TValue extends MediaNormalizationValue> = {
  requested?: TValue;
  applied?: TValue;
  derivedFrom?: string;
  supportedValues?: readonly TValue[];
};

export type MediaGenerationNormalizationMetadataInput = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<string>;
  durationSeconds?: MediaNormalizationEntry<number>;
};

function normalizeSupportedValues<TValue extends string>(values?: readonly TValue[]): TValue[] {
  return (values ?? []).filter((entry) => Boolean(normalizeOptionalString(entry)));
}

function selectClosestValue<T extends string>(
  values: readonly T[],
  score: (value: T) => { primary: number; secondary: number } | undefined,
): T | undefined {
  let best: { value: T; primary: number; secondary: number } | undefined;
  for (const value of values) {
    const next = score(value);
    if (
      next &&
      (!best ||
        (next.primary !== best.primary
          ? next.primary < best.primary
          : next.secondary !== best.secondary
            ? next.secondary < best.secondary
            : value.localeCompare(best.value) < 0))
    ) {
      best = { value, ...next };
    }
  }
  return best?.value;
}

function parsePositiveDimensionPair(
  raw: string | null | undefined,
  pattern: RegExp,
): { width: number; height: number } | null {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const match = pattern.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function parseAspectRatioValue(raw?: string | null): {
  width: number;
  height: number;
  value: number;
} | null {
  const pair = parsePositiveDimensionPair(raw, /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!pair) {
    return null;
  }
  return {
    width: pair.width,
    height: pair.height,
    value: pair.width / pair.height,
  };
}

function parseSizeValue(raw?: string | null): {
  width: number;
  height: number;
  aspectRatio: number;
  area: number;
} | null {
  const pair = parsePositiveDimensionPair(raw, /^(\d+)\s*x\s*(\d+)$/i);
  if (!pair) {
    return null;
  }
  if (!Number.isSafeInteger(pair.width) || !Number.isSafeInteger(pair.height)) {
    return null;
  }
  return {
    width: pair.width,
    height: pair.height,
    aspectRatio: pair.width / pair.height,
    area: pair.width * pair.height,
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

/** Derives a reduced aspect ratio string from a WIDTHxHEIGHT size. */
function deriveAspectRatioFromSize(size?: string): string | undefined {
  const parsed = parseSizeValue(size);
  if (!parsed) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(parsed.width, parsed.height);
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

export function resolveClosestAspectRatio(params: {
  requestedAspectRatio?: string;
  requestedSize?: string;
  supportedAspectRatios?: readonly string[];
}): string | undefined {
  const supported = normalizeSupportedValues(params.supportedAspectRatios);
  if (supported.length === 0) {
    return params.requestedAspectRatio ?? deriveAspectRatioFromSize(params.requestedSize);
  }
  if (params.requestedAspectRatio && supported.includes(params.requestedAspectRatio)) {
    return params.requestedAspectRatio;
  }
  const requested =
    parseAspectRatioValue(params.requestedAspectRatio) ??
    parseAspectRatioValue(deriveAspectRatioFromSize(params.requestedSize));
  if (!requested) {
    return undefined;
  }

  return selectClosestValue(supported, (candidate) => {
    const parsed = parseAspectRatioValue(candidate);
    if (!parsed) {
      return undefined;
    }
    return {
      primary: Math.abs(Math.log(parsed.value / requested.value)),
      secondary: Math.abs(parsed.width * requested.height - requested.width * parsed.height),
    };
  });
}

/** Chooses the closest supported size by aspect ratio and area. */
export function resolveClosestSize(params: {
  requestedSize?: string;
  requestedAspectRatio?: string;
  supportedSizes?: readonly string[];
}): string | undefined {
  const supported = normalizeSupportedValues(params.supportedSizes);
  if (supported.length === 0) {
    return params.requestedSize;
  }
  if (params.requestedSize && supported.includes(params.requestedSize)) {
    return params.requestedSize;
  }
  const requested = parseSizeValue(params.requestedSize);
  const requestedAspectRatio = parseAspectRatioValue(params.requestedAspectRatio);
  const requestedRatio = requested?.aspectRatio ?? requestedAspectRatio?.value;
  if (requestedRatio === undefined) {
    return undefined;
  }

  return selectClosestValue(supported, (candidate) => {
    const parsed = parseSizeValue(candidate);
    if (!parsed) {
      return undefined;
    }
    return {
      primary: Math.abs(Math.log(parsed.aspectRatio / requestedRatio)),
      secondary: requested ? Math.abs(Math.log(parsed.area / requested.area)) : parsed.area,
    };
  });
}

/** Chooses the closest supported resolution within the same numeric unit. */
export function resolveClosestResolution<TResolution extends string>(params: {
  requestedResolution?: TResolution;
  supportedResolutions?: readonly TResolution[];
}): TResolution | undefined {
  const supported = normalizeSupportedValues(params.supportedResolutions);
  if (supported.length === 0) {
    return params.requestedResolution;
  }
  if (params.requestedResolution && supported.includes(params.requestedResolution)) {
    return params.requestedResolution;
  }
  const requestedNumeric = parseResolutionRank(params.requestedResolution);
  if (!requestedNumeric) {
    return undefined;
  }
  return selectClosestValue(supported, (candidate) => {
    const candidateNumeric = parseResolutionRank(candidate);
    if (!candidateNumeric || candidateNumeric.unit !== requestedNumeric.unit) {
      return undefined;
    }
    return {
      primary: Math.abs(candidateNumeric.value - requestedNumeric.value),
      secondary: candidateNumeric.value < requestedNumeric.value ? 1 : 0,
    };
  });
}

function parseResolutionRank(
  resolution: string | undefined,
): { value: number; unit: "K" | "P" } | undefined {
  const match = resolution?.trim().match(/^(\d+(?:\.\d+)?)([kp])$/iu);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[2]?.toUpperCase() === "K" ? "K" : "P";
  return {
    value: unit === "K" ? value * 1000 : value,
    unit,
  };
}

/** Rounds duration and clamps it to a provider maximum when supplied. */
export function normalizeDurationToClosestMax(
  durationSeconds?: number,
  maxDurationSeconds?: number,
) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(1, Math.round(durationSeconds));
  if (
    typeof maxDurationSeconds !== "number" ||
    !Number.isFinite(maxDurationSeconds) ||
    maxDurationSeconds <= 0
  ) {
    return rounded;
  }
  return Math.min(rounded, Math.max(1, Math.round(maxDurationSeconds)));
}

export function buildMediaGenerationNormalizationMetadata(params: {
  normalization?: MediaGenerationNormalizationMetadataInput;
  requestedSizeForDerivedAspectRatio?: string;
  includeSupportedDurationSeconds?: boolean;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const { normalization } = params;
  if (normalization?.size?.requested !== undefined && normalization.size.applied !== undefined) {
    metadata.requestedSize = normalization.size.requested;
    metadata.normalizedSize = normalization.size.applied;
  }
  if (normalization?.aspectRatio?.applied !== undefined) {
    if (normalization.aspectRatio.requested !== undefined) {
      metadata.requestedAspectRatio = normalization.aspectRatio.requested;
    }
    metadata.normalizedAspectRatio = normalization.aspectRatio.applied;
    if (
      normalization.aspectRatio.derivedFrom === "size" &&
      params.requestedSizeForDerivedAspectRatio
    ) {
      metadata.requestedSize = params.requestedSizeForDerivedAspectRatio;
      metadata.aspectRatioDerivedFromSize = deriveAspectRatioFromSize(
        params.requestedSizeForDerivedAspectRatio,
      );
    }
  }
  if (
    normalization?.resolution?.requested !== undefined &&
    normalization.resolution.applied !== undefined
  ) {
    metadata.requestedResolution = normalization.resolution.requested;
    metadata.normalizedResolution = normalization.resolution.applied;
  }
  if (
    normalization?.durationSeconds?.requested !== undefined &&
    normalization.durationSeconds.applied !== undefined
  ) {
    metadata.requestedDurationSeconds = normalization.durationSeconds.requested;
    metadata.normalizedDurationSeconds = normalization.durationSeconds.applied;
    if (
      params.includeSupportedDurationSeconds &&
      normalization.durationSeconds.supportedValues?.length
    ) {
      metadata.supportedDurationSeconds = normalization.durationSeconds.supportedValues;
    }
  }
  return metadata;
}

type MediaGeometryCapabilities<TResolution extends string> = {
  sizes?: readonly string[];
  aspectRatios?: readonly string[];
  resolutions?: readonly TResolution[];
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
};

type MediaGeometryNormalization<TResolution extends string> = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<TResolution>;
};

type IgnoredMediaGeometryOverride<TResolution extends string> =
  | { key: "size" | "aspectRatio"; value: string }
  | { key: "resolution"; value: TResolution };

/** Normalizes shared image/video geometry while retaining their capability-specific contracts. */
export function resolveMediaGeometryOverrides<TResolution extends string>(params: {
  size?: string;
  aspectRatio?: string;
  resolution?: TResolution;
  capabilities?: MediaGeometryCapabilities<TResolution>;
  fallbackSizes?: readonly string[];
  reportUnrecognizedOverrides?: boolean;
  useAspectRatioForRequestedSize?: boolean;
}): {
  size?: string;
  aspectRatio?: string;
  resolution?: TResolution;
  ignoredOverrides: IgnoredMediaGeometryOverride<TResolution>[];
  normalization: MediaGeometryNormalization<TResolution>;
} {
  const caps = params.capabilities;
  const ignoredOverrides: IgnoredMediaGeometryOverride<TResolution>[] = [];
  const normalization: MediaGeometryNormalization<TResolution> = {};
  let { size, aspectRatio, resolution } = params;

  if (!caps) {
    return { size, aspectRatio, resolution, ignoredOverrides, normalization };
  }

  if (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {
    const normalizedSize = resolveClosestSize({
      requestedSize: size,
      requestedAspectRatio: params.useAspectRatioForRequestedSize ? aspectRatio : undefined,
      supportedSizes: caps.sizes,
    });
    if (normalizedSize && normalizedSize !== size) {
      normalization.size = { requested: size, applied: normalizedSize };
    } else if (!normalizedSize && params.reportUnrecognizedOverrides) {
      // Video-only sentinel values must remain visible when another provider rejects them.
      ignoredOverrides.push({ key: "size", value: size });
    }
    size = normalizedSize;
  }

  if (size && !caps.supportsSize) {
    // A size-only request can still be honored by providers that accept shape.
    const translated = caps.supportsAspectRatio
      ? resolveClosestAspectRatio({
          requestedAspectRatio: aspectRatio,
          requestedSize: size,
          supportedAspectRatios: caps.aspectRatios,
        })
      : undefined;
    if (translated) {
      aspectRatio = translated;
      normalization.aspectRatio = { applied: translated, derivedFrom: "size" };
    } else {
      ignoredOverrides.push({ key: "size", value: size });
    }
    size = undefined;
  }

  if (aspectRatio && (caps.aspectRatios?.length ?? 0) > 0 && caps.supportsAspectRatio) {
    const normalizedAspectRatio = resolveClosestAspectRatio({
      requestedAspectRatio: aspectRatio,
      requestedSize: size,
      supportedAspectRatios: caps.aspectRatios,
    });
    if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) {
      normalization.aspectRatio = { requested: aspectRatio, applied: normalizedAspectRatio };
    } else if (!normalizedAspectRatio && params.reportUnrecognizedOverrides) {
      // Video-only sentinel values must remain visible when another provider rejects them.
      ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    }
    aspectRatio = normalizedAspectRatio;
  } else if (aspectRatio && !caps.supportsAspectRatio) {
    const translated =
      caps.supportsSize && !size
        ? resolveClosestSize({
            requestedSize: params.size,
            requestedAspectRatio: aspectRatio,
            // Empty model lists mean unconstrained image sizes, not no provider-wide hints.
            supportedSizes: caps.sizes?.length === 0 ? params.fallbackSizes : caps.sizes,
          })
        : undefined;
    if (translated) {
      size = translated;
      normalization.size = { applied: translated, derivedFrom: "aspectRatio" };
    } else {
      ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    }
    aspectRatio = undefined;
  }

  if (resolution && (caps.resolutions?.length ?? 0) > 0 && caps.supportsResolution) {
    const normalizedResolution = resolveClosestResolution({
      requestedResolution: resolution,
      supportedResolutions: caps.resolutions,
    });
    if (normalizedResolution && normalizedResolution !== resolution) {
      normalization.resolution = { requested: resolution, applied: normalizedResolution };
    } else if (!normalizedResolution && params.reportUnrecognizedOverrides) {
      ignoredOverrides.push({ key: "resolution", value: resolution });
    }
    resolution = normalizedResolution;
  } else if (resolution && !caps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  return { size, aspectRatio, resolution, ignoredOverrides, normalization };
}
