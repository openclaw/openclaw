#!/usr/bin/env python3
"""
VTL Probe — Visual Thinking Lens (VTL)
Deterministic compositional measurement from gradient field.

Outputs JSON with valid/mask_status gate. If valid=false or mask_status=FAIL,
downstream tools must not interpret coordinates.

Usage:
    python3 scripts/vtl_probe.py <image_path>
    python3 scripts/vtl_probe.py <folder_path>   # batch -> metrics.jsonl

Author: Russell Parrish — https://artistinfluencer.com
Framework: https://github.com/rusparrish/Visual-Thinking-Lens
"""

import sys, os, json
import numpy as np
import cv2
from glob import glob
from scipy.spatial import ConvexHull
from scipy.optimize import curve_fit
from skimage.measure import label, find_contours
from skimage.filters import gaussian
from scipy.signal import savgol_filter

# ── FROZEN DEVICE CONSTANTS ───────────────────────────────────────────────────
# Any change breaks cross-image comparability. Treat as version-locked.
TARGET_MAX_SIDE       = 1536
GRAD_LOW_PCT          = 85.0
GRAD_HIGH_PCT         = 97.0
EDGE_MARGIN_PX        = 2
MIN_MASS_FRAC         = 0.001   # FAIL below this
WARN_MASS_FRAC        = 0.03    # WARN below this
R_V_ABSOLUTE_THRESH   = 0.15    # absolute, not percentile (intentional)
N_RADIAL_RINGS        = 20
EPS                   = 1e-9
IMAGE_EXTS            = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


# ── LOADING ───────────────────────────────────────────────────────────────────

def load_and_resize(path):
    path = os.path.realpath(os.path.abspath(path))
    data = open(path, "rb").read()
    arr  = np.frombuffer(data, dtype=np.uint8)
    img  = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Cannot decode image: {path}")
    h, w = img.shape[:2]
    scale = TARGET_MAX_SIDE / float(max(h, w))
    if scale != 1.0:
        interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
        img = cv2.resize(img, (int(round(w*scale)), int(round(h*scale))), interpolation=interp)
    return img


# ── GRADIENT FIELD + MASK ─────────────────────────────────────────────────────

def gradient_field(img_bgr):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    gx   = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy   = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gmag = np.sqrt(gx*gx + gy*gy)
    return gray, gx, gy, gmag

def build_mass_mask(gmag):
    """
    Percentile band mask: pixels between P85 and P97 of gradient magnitude.
    Contrast-invariant except for r_v which intentionally uses absolute threshold.
    """
    h, w = gmag.shape
    inner = gmag[EDGE_MARGIN_PX:h-EDGE_MARGIN_PX, EDGE_MARGIN_PX:w-EDGE_MARGIN_PX].ravel()
    t_lo  = np.percentile(inner, GRAD_LOW_PCT)
    t_hi  = np.percentile(inner, GRAD_HIGH_PCT)
    mask  = (gmag >= t_lo) & (gmag <= t_hi)
    mask[:EDGE_MARGIN_PX, :]  = False
    mask[-EDGE_MARGIN_PX:, :] = False
    mask[:, :EDGE_MARGIN_PX]  = False
    mask[:, -EDGE_MARGIN_PX:] = False
    return mask.astype(np.uint8)

def mask_qa(mask, gmag):
    """
    Returns status: PASS / WARN / FAIL and reasons.
    FAIL = do not interpret any coordinates downstream.
    """
    mass_frac = float(mask.sum() / mask.size)
    status, reasons = "PASS", []

    if mass_frac < MIN_MASS_FRAC:
        return "FAIL", [f"mass_fraction={mass_frac:.4f} below minimum {MIN_MASS_FRAC}"]
    if mass_frac < WARN_MASS_FRAC:
        status = "WARN"
        reasons.append(f"mass_fraction={mass_frac:.4f} in low-confidence band")

    lab = label(mask > 0, connectivity=2)
    n   = int(lab.max())
    if n == 0:
        return "FAIL", ["no connected components in mass mask"]

    counts = np.bincount(lab.ravel())[1:]
    largest_frac = float(counts.max() / max(mask.sum(), 1))

    if n > 10000:
        status = "WARN"
        reasons.append(f"high component count ({n}) — likely texture-driven field")
    if n > 2000 and largest_frac < 0.05:
        status = "WARN"
        reasons.append("island soup — many tiny components, no structural backbone")

    return status, reasons


# ── KERNEL METRICS ────────────────────────────────────────────────────────────

def metric_delta_xy(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0: return 0.0, 0.0
    h, w = mask.shape
    return (float((xs.mean() - (w-1)/2.0) / w),
            float((ys.mean() - (h-1)/2.0) / h))

def metric_r_v(gmag):
    """Absolute threshold — contrast-sensitive by design. Not percentile-based."""
    return float(1.0 - (gmag >= R_V_ABSOLUTE_THRESH).sum() / gmag.size)

def metric_rho_r(mask):
    """Convex hull packing density. Uses hull.volume (= 2D area in scipy)."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 3: return 0.0
    try:
        hull = ConvexHull(np.stack([xs, ys], axis=1).astype(np.float64))
        return float(100.0 * len(xs) / (hull.volume + EPS))
    except Exception:
        return 0.0


# ── G3 CURVATURE TORQUE ───────────────────────────────────────────────────────

def metric_g3(gray):
    """
    Curvature variance and inflection density along smoothed image contours.
    Uses Savitzky-Golay smoothing + signed curvature κ = (x'y'' - y'x'') / |v|^3
    This is the actual G3 computation, not an orientation variance proxy.
    """
    g        = gaussian(gray, sigma=1.0)
    contours = find_contours(g, level=float(g.mean()))
    if not contours:
        return {"k_var": 0.0, "infl_density": 0.0}

    curvs, infl = [], 0
    for c in contours:
        if len(c) < 9: continue
        x, y = c[:,1], c[:,0]
        k = 9 if len(c) >= 9 else (len(c)-1 if (len(c)-1)%2==1 else len(c)-2)
        if k < 3: continue
        xs = savgol_filter(x, k, 2, mode='interp')
        ys = savgol_filter(y, k, 2, mode='interp')
        dx  = np.gradient(xs);  dy  = np.gradient(ys)
        ddx = np.gradient(dx);  ddy = np.gradient(dy)
        kappa = (dx*ddy - dy*ddx) / ((dx*dx + dy*dy)**1.5 + EPS)
        curvs.append(kappa)
        infl += int(np.sum(np.sign(kappa[:-1]) != np.sign(kappa[1:])))

    if not curvs:
        return {"k_var": 0.0, "infl_density": 0.0}
    curvs = np.concatenate(curvs)
    return {
        "k_var":        float(np.var(curvs)),
        "infl_density": float(infl / max(1, curvs.size))
    }


# ── RADIAL COMPLIANCE (RCA-2 APPROXIMATION) ───────────────────────────────────

def _radial_profile(gmag, cx, cy):
    h, w   = gmag.shape
    ys, xs = np.mgrid[0:h, 0:w]
    dist   = np.sqrt((xs-cx)**2 + (ys-cy)**2)
    max_r  = dist.max() + EPS
    bins   = np.linspace(0, max_r, N_RADIAL_RINGS + 1)
    return np.array([
        float(gmag[(dist >= bins[i]) & (dist < bins[i+1])].mean())
        if ((dist >= bins[i]) & (dist < bins[i+1])).any() else 0.0
        for i in range(N_RADIAL_RINGS)
    ])

def _jsd(p, q):
    p = np.array(p, dtype=np.float64) + EPS
    q = np.array(q, dtype=np.float64) + EPS
    p /= p.sum(); q /= q.sum()
    m = 0.5*(p+q)
    kl = lambda a,b: np.sum(a * np.log(a/b))
    return float(0.5*kl(p,m) + 0.5*kl(q,m))

def _compliance(profile):
    x = np.linspace(0, 1, len(profile))
    try:
        popt, _ = curve_fit(lambda t,a: np.exp(-a*t),
                            x, profile/(profile.max()+EPS), p0=[1.0], maxfev=1000)
        alpha = float(popt[0])
    except Exception:
        alpha = 1.0
    ideal = np.exp(-alpha * x); ideal /= ideal.sum() + EPS
    norm  = profile / (profile.sum() + EPS)
    return float(1.0 - _jsd(norm, ideal))

def metric_radial(gmag, mask):
    h, w   = gmag.shape
    fc_x, fc_y = (w-1)/2.0, (h-1)/2.0
    ys, xs = np.nonzero(mask)
    if len(xs) < 10:
        return {"RC_f": 0.0, "RC_s": None, "dRC": None, "dRC_label": "insufficient mass"}

    mc_x, mc_y = float(xs.mean()), float(ys.mean())
    RC_f = _compliance(_radial_profile(gmag, fc_x, fc_y))
    RC_s = _compliance(_radial_profile(gmag, mc_x, mc_y))
    dRC  = RC_s - RC_f

    offset = np.sqrt((mc_x-fc_x)**2 + (mc_y-fc_y)**2) / min(h,w)
    if offset < 0.03:
        label = "dual-center (mass≈frame)"
    elif dRC < -0.06:
        label = "frame-dominant (radial collapse)"
    elif dRC > 0.06:
        label = "mass-dominant"
    else:
        label = "neutral"

    return {"RC_f": round(RC_f,4), "RC_s": round(RC_s,4),
            "dRC": round(dRC,4), "dRC_label": label}


# ── FLAGS ─────────────────────────────────────────────────────────────────────

def compute_flags(dx, dy, r_v, dRC, k_var):
    flags = []
    if abs(dx) < 0.05 and abs(dy) < 0.05:
        flags.append("CENTER_LOCK")
    if dRC is not None and dRC < -0.06:
        flags.append("RADIAL_COLLAPSE")
    if k_var is not None and k_var < 0.5:
        flags.append("LOW_TENSION")
    return flags


# ── MAIN ──────────────────────────────────────────────────────────────────────

def analyze(path):
    try:
        img = load_and_resize(path)
    except Exception as e:
        return {"valid": False, "mask_status": "FAIL", "error": str(e)}

    gray, gx, gy, gmag = gradient_field(img)
    mask = build_mass_mask(gmag)
    status, reasons = mask_qa(mask, gmag)

    if status == "FAIL":
        return {
            "valid": False,
            "mask_status": "FAIL",
            "mask_reasons": reasons,
            "error": "Measurement failed — " + "; ".join(reasons)
        }

    dx, dy   = metric_delta_xy(mask)
    r_v      = metric_r_v(gmag)
    rho_r    = metric_rho_r(mask)
    g3       = metric_g3(gray)
    radial   = metric_radial(gmag, mask)
    dRC      = radial.get("dRC")
    flags    = compute_flags(dx, dy, r_v, dRC, g3.get("k_var"))

    return {
        "valid":         True,
        "mask_status":   status,
        "mask_reasons":  reasons,
        "delta_x":       round(dx, 4),
        "delta_y":       round(dy, 4),
        "r_v":           round(r_v, 4),
        "rho_r":         round(rho_r, 2),
        "dRC":           dRC,
        "dRC_label":     radial.get("dRC_label"),
        "RC_f":          radial.get("RC_f"),
        "RC_s":          radial.get("RC_s"),
        "k_var":         round(g3["k_var"], 4),
        "infl_density":  round(g3["infl_density"], 6),
        "mass_fraction": round(float(mask.sum() / mask.size), 4),
        "gradient_floor_85": round(float(np.percentile(gmag.ravel(), 85)), 4),
        "flags":         flags
    }

def main(path):
    if os.path.isdir(path):
        files = [f for f in glob(os.path.join(path, "*.*"))
                 if os.path.splitext(f.lower())[1] in IMAGE_EXTS]
        out   = os.path.join(path, "metrics.jsonl")
        if os.path.exists(out):
            print(f"Warning: {out} already exists and will be overwritten.", file=sys.stderr)
        with open(out, "w") as fh:
            for f in sorted(files):
                r = analyze(f)
                fh.write(json.dumps({"file": f, **r}) + "\n")
        print(f"Batch complete: {out}")
    else:
        print(json.dumps(analyze(path), indent=2))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/vtl_probe.py <image_or_folder>")
        sys.exit(1)
    main(sys.argv[1])
