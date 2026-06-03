/**
 * Structured editorial prompt contract for fal.ai image generation.
 *
 * The same prompt format works across FLUX.2, Gemini "Nano Banana", and Imagen 3.
 * Negative-prompt language is inlined via `EDITION_AVOID` and applied by
 * `fal-models.ts` because FLUX.2 ignores the `negative_prompt` API param.
 */

export type HistoricalLayer = 'renaissance' | 'baroque' | 'atelier' | 'architectural' | 'industrial';
export type CameraMode = 'wide' | 'medium' | 'macro' | 'isometric' | 'low-angle';
export type OutputRole = 'hero' | 'chapter-bg' | 'foreground-object' | 'poster' | 'motion-source';

export type EditionAssetPrompt = {
  chapterId: string;
  subject: string;
  productTruth: string;
  historicalLayer: HistoricalLayer;
  modernLayer: string;
  palette: string[];
  camera: CameraMode;
  outputRole: OutputRole;
  /** Optional — deterministic generation when set. */
  seed?: number;
  /** Optional — override the default editorial aesthetic for a single chapter. */
  aestheticDirection?: string;
};

const HISTORICAL_GUIDANCE: Record<HistoricalLayer, string> = {
  renaissance:
    'Renaissance composition: layered chiaroscuro, dramatic fabric, sfumato edges, classical proportions, museum-grade lighting.',
  baroque:
    'Baroque composition: theatrical movement, deep shadow contrast, gilded textures, dynamic diagonals, opulent palette.',
  atelier:
    'Painterly atelier composition: visible brushwork, warm sepia base, soft natural studio light, painterly imperfection.',
  architectural:
    'Architectural drafting composition: orthographic clarity, parchment tones, fine ink lines, structural geometry, blueprint sensibility.',
  industrial:
    'Industrial-era composition: forged metal, oxidised brass, steam-warm light, mechanical detail, victorian engine-room atmosphere.',
};

const CAMERA_GUIDANCE: Record<CameraMode, string> = {
  wide: 'Wide cinematic shot, deep field, atmospheric perspective.',
  medium: 'Medium shot, balanced subject framing, contextual environment.',
  macro: 'Macro detail shot, shallow depth of field, tactile material focus.',
  isometric: 'Clean isometric projection, technical clarity, even lighting.',
  'low-angle': 'Low-angle hero shot, monumental perspective, sky negative space.',
};

const OUTPUT_ROLE_GUIDANCE: Record<OutputRole, string> = {
  hero: 'Primary chapter hero image. Compose with negative space at top-left for HTML title overlay.',
  'chapter-bg': 'Background plate. Subject de-emphasised, atmosphere primary, suitable for radial vignette overlay.',
  'foreground-object': 'Isolated subject on neutral background. Portrait crop. Clean edge separation for cut-out use.',
  poster: 'Editorial poster composition. Strong central subject, dramatic palette, frame-filling.',
  'motion-source': 'First-frame of a motion sequence. Stable composition, gentle implied movement.',
};

export function buildEditionPrompt(input: EditionAssetPrompt): string {
  const parts: string[] = [
    'Original editorial product-scene image for a high-craft interactive release website.',
    `Scene: ${input.subject}.`,
    `Product truth: ${input.productTruth}.`,
    HISTORICAL_GUIDANCE[input.historicalLayer],
    `Modern layer: ${input.modernLayer} — integrated naturally, not stickered on.`,
    `Palette: ${input.palette.join(', ')}.`,
    CAMERA_GUIDANCE[input.camera],
    OUTPUT_ROLE_GUIDANCE[input.outputRole],
  ];

  if (input.aestheticDirection) {
    parts.push(`Aesthetic direction: ${input.aestheticDirection}.`);
  }

  parts.push(
    'No brand logos, no readable text, no imitation of named living artists, no stock-photo gloss.',
  );

  return parts.join(' ');
}

/**
 * Inline negative-prompt language. Applied by `fal-models.ts` as
 * "Avoid: …" inside the main prompt string, because FLUX.2 Pro ignores
 * the `negative_prompt` API parameter.
 */
export const EDITION_AVOID = [
  'brand logos',
  'unreadable text overlays',
  'fake UI labels baked into the image',
  'watermarks',
  'low resolution',
  'distorted hands',
  'extra limbs',
  'over-saturated colour',
  'plastic skin',
  'generic AI gloss',
  'stock photography composition',
].join(', ');
