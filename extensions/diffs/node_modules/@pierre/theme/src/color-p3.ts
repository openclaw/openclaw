// src/color-p3.ts
// Convert sRGB hex colors to CSS Display P3 color space format

/**
 * Convert hex color to RGB values (0-1 range)
 */
function hexToRgb01(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '');
  const expanded = cleaned.length === 3
    ? cleaned.split('').map(x => x + x).join('')
    : cleaned;

  const num = parseInt(expanded, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;

  return [r, g, b];
}

/**
 * Apply sRGB gamma correction (linearize)
 */
function srgbToLinear(c: number): number {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Remove sRGB gamma correction (to display)
 */
function linearToSrgb(c: number): number {
  if (c <= 0.0031308) {
    return c * 12.92;
  }
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Apply Display P3 gamma correction (same as sRGB)
 */
const linearToP3 = linearToSrgb;

/**
 * Convert linear sRGB to linear Display P3
 * Using the standard conversion matrix from sRGB to P3
 */
function linearSrgbToLinearP3(r: number, g: number, b: number): [number, number, number] {
  // Conversion matrix from linear sRGB to linear Display P3
  // This matrix converts from sRGB primaries to P3 primaries via XYZ
  const rOut = 0.82246197 * r + 0.17753803 * g + 0.00000000 * b;
  const gOut = 0.03319420 * r + 0.96680580 * g + 0.00000000 * b;
  const bOut = 0.01708263 * r + 0.07239744 * g + 0.91051993 * b;

  return [rOut, gOut, bOut];
}

/**
 * Format a number for CSS color function (round to reasonable precision)
 */
function formatColorValue(value: number): string {
  // Clamp to 0-1 range
  const clamped = Math.max(0, Math.min(1, value));
  // Round to 6 decimal places for precision without being excessive
  return clamped.toFixed(6);
}

/**
 * Convert RGB to HSL color space
 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / delta + 2) / 6;
        break;
      case b:
        h = ((r - g) / delta + 4) / 6;
        break;
    }
  }

  return [h, s, l];
}

/**
 * Convert HSL to RGB color space
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return [r, g, b];
}

/**
 * Enhance colors to take advantage of P3's wider gamut
 * Increases saturation and vibrancy for colors that can benefit from P3
 */
function enhanceForP3Gamut(r: number, g: number, b: number): [number, number, number] {
  // Convert to HSL for easier saturation manipulation
  const [h, s, l] = rgbToHsl(r, g, b);

  // Only enhance colors that have some saturation and aren't too light or dark
  // (grays and near-blacks/whites don't benefit from P3 enhancement)
  if (s < 0.1 || l < 0.1 || l > 0.9) {
    return [r, g, b];
  }

  // Calculate enhancement factor based on original saturation
  // More saturated colors get more enhancement (they can handle it)
  const saturationBoost = 0.15 + (s * 0.15); // 15-30% boost depending on saturation

  // Boost saturation, but not beyond 1.0
  let newS = s + (s * saturationBoost);
  newS = Math.min(1.0, newS);

  // For highly saturated colors, also slightly increase luminance to make them "pop"
  // but only if they're not already too light
  let newL = l;
  if (s > 0.5 && l < 0.7) {
    newL = l + (l * 0.05); // Slight 5% luminance boost for vibrant colors
    newL = Math.min(0.9, newL);
  }

  // Convert back to RGB
  return hslToRgb(h, newS, newL);
}

/**
 * Convert sRGB hex color to CSS Display P3 color format with enhancement
 * Returns: "color(display-p3 r g b)" or "color(display-p3 r g b / alpha)"
 */
export function srgbHexToP3Color(srgbHex: string, enhance: boolean = true): string {
  // Handle alpha channel if present
  const hasAlpha = srgbHex.length === 9 || (srgbHex.startsWith('#') && srgbHex.length === 9);
  let alpha = '';
  let colorHex = srgbHex;

  if (hasAlpha) {
    const alphaHex = srgbHex.slice(-2);
    const alphaValue = parseInt(alphaHex, 16) / 255;
    alpha = ` / ${formatColorValue(alphaValue)}`;
    colorHex = srgbHex.slice(0, -2);
  }

  // Convert to linear sRGB
  const [sR, sG, sB] = hexToRgb01(colorHex);
  const linearSR = srgbToLinear(sR);
  const linearSG = srgbToLinear(sG);
  const linearSB = srgbToLinear(sB);

  // Convert to linear P3
  const [linearPR, linearPG, linearPB] = linearSrgbToLinearP3(linearSR, linearSG, linearSB);

  // Apply P3 gamma to get display values
  let pR = linearToP3(linearPR);
  let pG = linearToP3(linearPG);
  let pB = linearToP3(linearPB);

  // Enhance colors to take advantage of P3's wider gamut
  if (enhance) {
    [pR, pG, pB] = enhanceForP3Gamut(pR, pG, pB);
  }

  // Format as CSS color(display-p3 ...) function
  return `color(display-p3 ${formatColorValue(pR)} ${formatColorValue(pG)} ${formatColorValue(pB)}${alpha})`;
}

/**
 * Convert all colors in a Roles object to Display P3
 */
export function convertRolesToP3<T>(obj: T): T {
  if (typeof obj === 'string') {
    // If it's a hex color string, convert it
    if ((obj as string).match(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)) {
      return srgbHexToP3Color(obj as string) as any;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => convertRolesToP3(item)) as any;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj as any)) {
      result[key] = convertRolesToP3(value);
    }
    return result;
  }

  return obj;
}
