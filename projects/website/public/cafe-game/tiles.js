(function () {
  'use strict';
  var T = 32, cache = {}, ambienceCanvas = null;

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w || T; c.height = h || T;
    return c;
  }

  function renderWoodFloor(color, darkColor) {
    var c = makeCanvas(), g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, T, T);

    // Parse base color for tinting
    var r = parseInt(color.substr(1, 2), 16);
    var gv = parseInt(color.substr(3, 2), 16);
    var b = parseInt(color.substr(5, 2), 16);

    // ── Warm overhead light gradient (top = pendant zone, bottom = shadow) ──
    // Applied FIRST so planks paint on top of it
    var lightGrd = g.createLinearGradient(0, 0, 0, T);
    lightGrd.addColorStop(0,   'rgba(255,210,140,0.18)');
    lightGrd.addColorStop(0.4, 'rgba(255,200,120,0.10)');
    lightGrd.addColorStop(1,   'rgba(20,10,0,0.12)');
    g.fillStyle = lightGrd; g.fillRect(0, 0, T, T);

    // ── 4 planks, each 8px tall with per-plank color variation ──
    var plankH = 8;
    for (var p = 0; p < 4; p++) {
      var py = p * plankH;
      // Bolder alternating plank tones — reads even when tiles are tiny
      var tint = (p % 2 === 0) ? 18 : -12;
      var pr = Math.min(255, Math.max(0, r + tint));
      var pg = Math.min(255, Math.max(0, gv + tint));
      var pb = Math.min(255, Math.max(0, b + tint));
      g.fillStyle = 'rgb(' + pr + ',' + pg + ',' + pb + ')';
      g.fillRect(0, py, T, plankH);

      // Horizontal grain lines — stronger so they read at phone scale
      for (var gl = py + 2; gl < py + plankH - 1; gl += 3) {
        var ga = 0.08 + Math.sin(gl * 1.5 + p * 4) * 0.04;
        g.strokeStyle = 'rgba(0,0,0,' + ga.toFixed(3) + ')';
        g.lineWidth = 0.7;
        g.beginPath();
        g.moveTo(0, gl);
        g.quadraticCurveTo(T * 0.5, gl + Math.sin(p * 2.3 + gl * 0.3) * 1.2, T, gl);
        g.stroke();
      }

      // ── Plank groove — the most important read at phone scale ──
      if (p > 0) {
        // Dark shadow line (2px for visibility)
        g.fillStyle = darkColor;
        g.fillRect(0, py, T, 2);
        // Bright highlight just above groove (simulates beveled plank edge catching light)
        g.fillStyle = 'rgba(255,220,150,0.18)';
        g.fillRect(0, py - 1, T, 1);
        // Deep shadow just below groove lip
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(0, py + 1, T, 1);
      }
    }

    // ── Vertical plank joints (staggered) ──
    var jointX = 10 + ((r * 3 + gv * 7) % 14);
    // Top-half joint: bold dark line + edge highlight
    g.fillStyle = darkColor;
    g.fillRect(jointX, 0, 2, plankH * 2);
    g.fillStyle = 'rgba(255,220,150,0.12)';
    g.fillRect(jointX + 2, 0, 1, plankH * 2);
    // Bottom-half joint, offset
    var jointX2 = (jointX + 14) % (T - 6) + 3;
    g.fillStyle = darkColor;
    g.fillRect(jointX2, plankH * 2, 2, plankH * 2);
    g.fillStyle = 'rgba(255,220,150,0.10)';
    g.fillRect(jointX2 + 2, plankH * 2, 1, plankH * 2);

    // ── Wood knots — larger and more contrasty so they read ──
    var knotPositions = [
      { x: 7 + (gv % 10), y: 4 + (r % 5), rad: 3 + (b % 2) },
      { x: 20 + (b % 8), y: 18 + (gv % 6), rad: 2.5 + (r % 2) },
    ];
    for (var ki = 0; ki < knotPositions.length; ki++) {
      var knot = knotPositions[ki];
      var kx = knot.x, ky = knot.y, kr = knot.rad;

      // Concentric growth rings — visible alpha
      for (var ring = 3; ring >= 1; ring--) {
        var ringR = kr * (0.4 + ring * 0.28);
        var ringAlpha = 0.10 + (3 - ring) * 0.06;
        g.strokeStyle = 'rgba(35,15,5,' + ringAlpha.toFixed(3) + ')';
        g.lineWidth = 0.8;
        g.beginPath();
        g.ellipse(kx, ky, ringR, ringR * (0.65 + ki * 0.12), 0.3 * ki, 0, Math.PI * 2);
        g.stroke();
      }

      // Dark heartwood center
      var centerGrd = g.createRadialGradient(kx, ky, 0, kx, ky, kr * 0.7);
      centerGrd.addColorStop(0, 'rgba(25,10,3,0.30)');
      centerGrd.addColorStop(1, 'rgba(25,10,3,0)');
      g.fillStyle = centerGrd;
      g.beginPath(); g.arc(kx, ky, kr * 0.7, 0, Math.PI * 2); g.fill();

      // Grain deflection around knot
      g.strokeStyle = 'rgba(35,15,5,0.10)'; g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(kx - kr - 4, ky);
      g.quadraticCurveTo(kx, ky - kr - 2, kx + kr + 4, ky);
      g.stroke();
      g.beginPath();
      g.moveTo(kx - kr - 3, ky + 1.5);
      g.quadraticCurveTo(kx, ky + kr + 1.5, kx + kr + 3, ky + 1.5);
      g.stroke();
    }

    // ── Polished sheen — vertical top-down (pendant light reflection) ──
    var sheen = g.createLinearGradient(0, 0, 0, T);
    sheen.addColorStop(0,   'rgba(255,235,190,0.13)');
    sheen.addColorStop(0.35,'rgba(255,225,170,0.06)');
    sheen.addColorStop(1,   'rgba(255,225,170,0)');
    g.fillStyle = sheen; g.fillRect(0, 0, T, T);

    // ── Lived-in details ──
    // Coffee drip stain
    var stainX = 5 + (r * 3 + b * 2) % 18;
    var stainY = 4 + (gv * 5 + r) % 20;
    var stainR = 1.5 + (b % 3) * 0.5;
    g.strokeStyle = 'rgba(60,30,10,0.14)'; g.lineWidth = 1.0;
    g.beginPath(); g.arc(stainX, stainY, stainR, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(60,30,10,0.03)';
    g.beginPath(); g.arc(stainX, stainY, stainR * 0.7, 0, Math.PI * 2); g.fill();

    // Micro-scratches
    g.strokeStyle = 'rgba(0,0,0,0.14)'; g.lineWidth = 1.0;
    var scrX1 = (r * 7 + gv) % 24 + 2;
    var scrY1 = (b * 3 + r * 2) % 8 + 2;
    g.beginPath(); g.moveTo(scrX1, scrY1); g.lineTo(scrX1 + 5 + (gv % 4), scrY1 + 1); g.stroke();
    var scrX2 = (gv * 5 + b * 3) % 20 + 4;
    var scrY2 = (r * 4 + gv) % 10 + 16;
    g.beginPath(); g.moveTo(scrX2, scrY2); g.lineTo(scrX2 + 4 + (r % 3), scrY2 - 0.5); g.stroke();

    // Crumb specks
    g.fillStyle = 'rgba(120,90,50,0.07)';
    g.fillRect((r * 2 + 5) % 26 + 3, (gv * 3 + 1) % 24 + 4, 1, 1);
    g.fillRect((b * 4 + 11) % 22 + 5, (r + gv) % 20 + 8, 0.8, 0.8);
    g.fillStyle = 'rgba(200,190,170,0.06)';
    g.fillRect((gv * 6 + 3) % 24 + 4, (b * 2 + 7) % 22 + 6, 0.7, 0.7);

    return c;
  }

  function renderCarpet() {
    var c = makeCanvas(), g = c.getContext('2d');
    var mx = T / 2, my = T / 2;

    // ── Base: uniform warm burgundy (no per-tile gradient = seamless) ──
    g.fillStyle = '#4a1a1a'; g.fillRect(0, 0, T, T);

    // ── Woven texture: very subtle — just enough to not look flat ──
    // Horizontal warp (halved opacity — reads as "fabric" not "noise" at distance)
    for (var wy = 0; wy < T; wy += 4) {
      g.fillStyle = (wy % 8 < 4)
        ? 'rgba(90,30,28,0.025)'
        : 'rgba(55,18,18,0.02)';
      g.fillRect(0, wy, T, 2);
    }
    // Vertical weft (minimal — just breaks up the horizontal)
    for (var wx = 0; wx < T; wx += 4) {
      g.fillStyle = 'rgba(70,25,22,0.015)';
      g.fillRect(wx, 0, 2, T);
    }

    // ── No per-tile border (carpet tiles are seamless) ──
    // Gold thread accents — fillRect instead of stroke for crisp sub-pixel-safe lines
    g.fillStyle = 'rgba(184,134,58,0.38)';
    g.fillRect(0, Math.round(T / 3), T, 1);
    g.fillRect(0, Math.round(T * 2 / 3), T, 1);
    g.fillRect(Math.round(T / 3), 0, 1, T);
    g.fillRect(Math.round(T * 2 / 3), 0, 1, T);

    // ── Kilim zigzag (reduced — wide spacing, lower opacity, reads as pattern not noise) ──
    g.strokeStyle = 'rgba(140,55,50,0.18)'; g.lineWidth = 1.0;
    for (var zi = -T; zi < T * 2; zi += 12) {
      g.beginPath();
      g.moveTo(zi, 6);
      for (var zy = 6; zy < T - 6; zy += 6) {
        var zx = zi + ((zy / 6) % 2 === 0 ? 4 : -4);
        g.lineTo(zx, zy);
      }
      g.stroke();
    }

    // ── Diamond medallion motifs (kilim style, repeating) ──
    // Small diamond at center and quarter-offset positions (tile-seamless)
    var diamonds = [
      { x: T / 2, y: T / 2, main: true },
      { x: 0, y: 0 }, { x: T, y: 0 }, { x: 0, y: T }, { x: T, y: T },
    ];
    for (var di = 0; di < diamonds.length; di++) {
      var dx = diamonds[di].x, dy = diamonds[di].y;
      var isMain = diamonds[di].main;
      var dSize = isMain ? 5 : 3;

      // Outermost diamond ring (dark border)
      g.strokeStyle = 'rgba(80,25,20,0.2)'; g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(dx, dy - dSize); g.lineTo(dx + dSize, dy);
      g.lineTo(dx, dy + dSize); g.lineTo(dx - dSize, dy);
      g.closePath(); g.stroke();

      // Filled diamond (dark accent)
      g.fillStyle = 'rgba(100,35,30,0.2)';
      g.beginPath();
      g.moveTo(dx, dy - dSize + 0.5); g.lineTo(dx + dSize - 0.5, dy);
      g.lineTo(dx, dy + dSize - 0.5); g.lineTo(dx - dSize + 0.5, dy);
      g.closePath(); g.fill();

      // Mid diamond (deep red)
      g.fillStyle = 'rgba(130,45,40,0.12)';
      g.beginPath();
      g.moveTo(dx, dy - dSize + 1.5); g.lineTo(dx + dSize - 1.5, dy);
      g.lineTo(dx, dy + dSize - 1.5); g.lineTo(dx - dSize + 1.5, dy);
      g.closePath(); g.fill();

      // Inner diamond (gold — boosted for mobile visibility)
      g.fillStyle = 'rgba(184,134,58,0.18)';
      g.beginPath();
      g.moveTo(dx, dy - dSize + 2.5); g.lineTo(dx + dSize - 2.5, dy);
      g.lineTo(dx, dy + dSize - 2.5); g.lineTo(dx - dSize + 2.5, dy);
      g.closePath(); g.fill();

      if (isMain) {
        // Center star (8-pointed — overlapping squares at 45°)
        g.fillStyle = 'rgba(184,134,58,0.08)';
        g.save(); g.translate(dx, dy); g.rotate(Math.PI / 4);
        g.fillRect(-1.5, -1.5, 3, 3);
        g.restore();
        g.fillRect(dx - 1.5, dy - 1.5, 3, 3);
        // Center dot (bright gold — the one pixel that says "this is a pattern")
        g.fillStyle = 'rgba(220,180,80,0.28)';
        g.beginPath(); g.arc(dx, dy, 0.8, 0, Math.PI * 2); g.fill();

        // Hook motifs radiating from center medallion (4 cardinal directions)
        g.strokeStyle = 'rgba(140,55,45,0.1)'; g.lineWidth = 0.5;
        // Top hook
        g.beginPath(); g.moveTo(dx, dy - dSize - 1); g.lineTo(dx, dy - dSize - 2.5);
        g.quadraticCurveTo(dx + 1.5, dy - dSize - 2.5, dx + 1.5, dy - dSize - 1); g.stroke();
        // Bottom hook
        g.beginPath(); g.moveTo(dx, dy + dSize + 1); g.lineTo(dx, dy + dSize + 2.5);
        g.quadraticCurveTo(dx - 1.5, dy + dSize + 2.5, dx - 1.5, dy + dSize + 1); g.stroke();
        // Left hook
        g.beginPath(); g.moveTo(dx - dSize - 1, dy); g.lineTo(dx - dSize - 2.5, dy);
        g.quadraticCurveTo(dx - dSize - 2.5, dy + 1.5, dx - dSize - 1, dy + 1.5); g.stroke();
        // Right hook
        g.beginPath(); g.moveTo(dx + dSize + 1, dy); g.lineTo(dx + dSize + 2.5, dy);
        g.quadraticCurveTo(dx + dSize + 2.5, dy - 1.5, dx + dSize - 0, dy - 1.5); g.stroke();
      }
    }

    // (Scattered cross motifs removed — unreadable at mobile scale, added noise)

    // ── Stepped border runners (horizontal, tile-seamless) ──
    g.fillStyle = 'rgba(140,55,45,0.12)';
    // Top border step pattern
    for (var bx = 0; bx < T; bx += 4) {
      var stepH = (bx % 8 < 4) ? 2 : 3;
      g.fillRect(bx, 2, 2, stepH);
    }
    // Bottom border step pattern (mirrored)
    for (var bx2 = 0; bx2 < T; bx2 += 4) {
      var stepH2 = (bx2 % 8 < 4) ? 3 : 2;
      g.fillRect(bx2, T - 2 - stepH2, 2, stepH2);
    }

    // ── Threadbare wear spots (subtle lighter patches) ──
    g.fillStyle = 'rgba(80,35,30,0.06)';
    g.fillRect(6, 12, 5, 3);
    g.fillRect(20, 22, 4, 2);

    // ── Corner rosette ornaments (quarter-circles at each corner, seamless when tiled) ──
    var corners = [[0, 0], [T, 0], [0, T], [T, T]];
    for (var ci = 0; ci < corners.length; ci++) {
      var crx = corners[ci][0], cry = corners[ci][1];
      // Outer petal ring
      g.strokeStyle = 'rgba(184,134,58,0.19)'; g.lineWidth = 1.0;
      g.beginPath(); g.arc(crx, cry, 5, 0, Math.PI * 2); g.stroke();
      // Inner circle (darker)
      g.fillStyle = 'rgba(100,35,30,0.1)';
      g.beginPath(); g.arc(crx, cry, 3, 0, Math.PI * 2); g.fill();
      // Rosette center dot (gold)
      g.fillStyle = 'rgba(184,134,58,0.15)';
      g.beginPath(); g.arc(crx, cry, 1.2, 0, Math.PI * 2); g.fill();
      // 4 petals (tiny ellipses radiating out)
      g.fillStyle = 'rgba(140,55,45,0.08)';
      g.beginPath(); g.ellipse(crx, cry - 4, 1, 2, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(crx, cry + 4, 1, 2, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(crx - 4, cry, 2, 1, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(crx + 4, cry, 2, 1, 0, 0, Math.PI * 2); g.fill();
    }

    // ── Fringe detail — varied thread tassels on top and bottom edges ──
    // Threads vary in length (1.5–3px), color (dark root → cream tip), slight droop curve
    for (var fx = 1; fx < T; fx += 2) {
      var fSeed = (fx * 17 + 53) % 31;
      var fLen = 1.5 + (fSeed % 5) * 0.32;        // 1.5 → 2.9 px
      var fDroop = ((fSeed % 7) - 3) * 0.25;       // -0.75 → +0.75 px lateral curl
      var fAlpha = 0.18 + (fSeed % 4) * 0.06;      // 0.18 → 0.36
      var fTipAlpha = fAlpha * 0.55;                // tip fades to cream
      // Root stroke (dark red, same as carpet body)
      g.strokeStyle = 'rgba(110,42,36,' + fAlpha.toFixed(2) + ')';
      g.lineWidth = 0.8 + (fSeed % 3) * 0.15;
      // Top fringe
      g.beginPath(); g.moveTo(fx, 0); g.quadraticCurveTo(fx + fDroop * 0.5, fLen * 0.5, fx + fDroop, fLen); g.stroke();
      // Tip highlight (cream ivory — worn thread end)
      g.strokeStyle = 'rgba(200,170,130,' + fTipAlpha.toFixed(2) + ')';
      g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(fx + fDroop * 0.8, fLen * 0.75); g.lineTo(fx + fDroop, fLen); g.stroke();
      // Bottom fringe (mirrored, slightly different curl)
      var fDroop2 = -fDroop + ((fSeed % 5) - 2) * 0.1;
      g.strokeStyle = 'rgba(110,42,36,' + fAlpha.toFixed(2) + ')';
      g.lineWidth = 0.8 + (fSeed % 3) * 0.15;
      g.beginPath(); g.moveTo(fx, T); g.quadraticCurveTo(fx + fDroop2 * 0.5, T - fLen * 0.5, fx + fDroop2, T - fLen); g.stroke();
      g.strokeStyle = 'rgba(200,170,130,' + fTipAlpha.toFixed(2) + ')';
      g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(fx + fDroop2 * 0.8, T - fLen * 0.75); g.lineTo(fx + fDroop2, T - fLen); g.stroke();
    }

    // ── Pile micro-texture: alternating compressed/raised rows catch overhead light ──
    // Every ~3px a faint bright band (raised nap) followed by a darker gap (pressed nap)
    for (var py = 0; py < T; py += 6) {
      // Raised pile row — warm shimmer (light catches tips of fibers)
      g.fillStyle = 'rgba(160,80,60,0.04)';
      g.fillRect(0, py, T, 2);
      // Pressed pile row — slightly cooler, shadow in the groove
      g.fillStyle = 'rgba(30,10,10,0.035)';
      g.fillRect(0, py + 3, T, 2);
    }

    // ── Pile sheen: two crossing light bands simulating nap catching pendant lamp ──
    // Primary sheen: diagonal top-left → center (lamp directly above catches pile angle)
    var sheen1 = g.createLinearGradient(0, 0, T * 0.6, T * 0.6);
    sheen1.addColorStop(0,   'rgba(220,160,110,0.0)');
    sheen1.addColorStop(0.35,'rgba(220,160,110,0.07)');
    sheen1.addColorStop(0.5, 'rgba(255,190,130,0.11)');
    sheen1.addColorStop(0.65,'rgba(220,160,110,0.07)');
    sheen1.addColorStop(1,   'rgba(220,160,110,0.0)');
    g.fillStyle = sheen1; g.fillRect(0, 0, T, T);
    // Secondary sheen: subtle cross-band (nap combed in slight cross direction)
    var sheen2 = g.createLinearGradient(T, 0, 0, T);
    sheen2.addColorStop(0,   'rgba(255,200,150,0.0)');
    sheen2.addColorStop(0.4, 'rgba(255,200,150,0.04)');
    sheen2.addColorStop(0.55,'rgba(255,200,150,0.06)');
    sheen2.addColorStop(0.7, 'rgba(255,200,150,0.04)');
    sheen2.addColorStop(1,   'rgba(255,200,150,0.0)');
    g.fillStyle = sheen2; g.fillRect(0, 0, T, T);

    return c;
  }

  function renderWall() {
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Deep mortar base (visible in gaps between bricks) ──
    g.fillStyle = '#2a1c15'; g.fillRect(0, 0, T, T);

    // ── Bricks with natural variation ──
    var colors = ['#4a3020', '#3d2820', '#45302a', '#503828', '#42281c', '#553a2e'];
    var brickH = 8, brickW = 16;
    for (var row = 0; row < T; row += brickH) {
      var offset = ((row / brickH) % 2) * (brickW / 2);
      for (var col = -brickW + offset; col < T + brickW; col += brickW) {
        var seed = Math.abs(row * 7 + col * 13);
        var ci = seed % colors.length;
        var bx = col + 1, by = row + 1, bw = brickW - 2, bh = brickH - 2;

        // Brick base color
        g.fillStyle = colors[ci];
        g.fillRect(bx, by, bw, bh);

        // Surface texture — subtle noise (2-3 speckles per brick)
        var speckles = 2 + (seed % 2);
        for (var s = 0; s < speckles; s++) {
          var sx = bx + ((seed * (s + 3) * 17) % bw);
          var sy = by + ((seed * (s + 7) * 11) % bh);
          g.fillStyle = (s % 2 === 0)
            ? 'rgba(0,0,0,0.08)'
            : 'rgba(255,200,150,0.06)';
          g.fillRect(sx, sy, 1, 1);
        }

        // Top edge highlight (light catching top of brick)
        g.fillStyle = 'rgba(255,200,140,0.06)';
        g.fillRect(bx, by, bw, 1);
        // Bottom edge shadow (depth under each brick)
        g.fillStyle = 'rgba(0,0,0,0.1)';
        g.fillRect(bx, by + bh - 1, bw, 1);

        // Occasional weathered/chipped brick (every ~5th brick)
        if (seed % 5 === 0) {
          g.fillStyle = 'rgba(0,0,0,0.06)';
          var chipX = bx + (seed % (bw - 3));
          g.fillRect(chipX, by, 3, 2);
        }
      }
    }

    // ── Mortar line highlights (lighter grout catching ambient light) ──
    g.strokeStyle = 'rgba(90,70,55,0.25)'; g.lineWidth = 1.0;
    for (var mr = 0; mr < T; mr += brickH) {
      g.beginPath(); g.moveTo(0, mr + 0.5); g.lineTo(T, mr + 0.5); g.stroke();
    }

    // ── Mortar crumbling (tiny gaps where grout has worn away) ──
    g.fillStyle = 'rgba(15,10,5,0.12)';
    // Crumble spots along horizontal mortar lines
    g.fillRect(4, 8, 1.5, 1); g.fillRect(18, 16, 2, 1);
    g.fillRect(10, 24, 1, 1); g.fillRect(27, 8, 1.5, 1);
    // Tiny mortar dust below crumble (fallen granules)
    g.fillStyle = 'rgba(140,110,80,0.04)';
    g.fillRect(4, 9.5, 1, 0.5); g.fillRect(18, 17.5, 1.5, 0.5);

    // ── Brick color temperature variation (some warmer, some cooler) ──
    // Warm tint on a few bricks (slightly more orange)
    g.fillStyle = 'rgba(200,100,40,0.03)';
    g.fillRect(1, 1, 14, 6);     // top-left brick warmer
    g.fillRect(9, 17, 14, 6);    // middle brick warmer
    // Cool tint on others (slightly more grey-blue)
    g.fillStyle = 'rgba(60,80,100,0.02)';
    g.fillRect(17, 1, 14, 6);    // top-right brick cooler
    g.fillRect(1, 9, 14, 6);     // second-row left cooler

    // ── Warm interior light wash (cafe glow on brick) ──
    var warmGrd = g.createRadialGradient(T / 2, T, 2, T / 2, T * 0.3, T * 1.2);
    warmGrd.addColorStop(0, 'rgba(255,180,80,0.08)');
    warmGrd.addColorStop(0.5, 'rgba(255,160,60,0.03)');
    warmGrd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = warmGrd; g.fillRect(0, 0, T, T);

    // ── Ceiling shadow (top darker) ──
    var ceilGrd = g.createLinearGradient(0, 0, 0, T);
    ceilGrd.addColorStop(0, 'rgba(0,0,0,0.15)');
    ceilGrd.addColorStop(0.3, 'rgba(0,0,0,0.04)');
    ceilGrd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ceilGrd; g.fillRect(0, 0, T, T);

    // ── Aged patina (subtle moss/damp tint near ceiling) ──
    g.fillStyle = 'rgba(60,80,50,0.02)';
    g.fillRect(0, 0, T, 6);

    // ── Water stain trail (from ceiling leak, long-dried) ──
    g.strokeStyle = 'rgba(50,35,25,0.03)'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(22, 0);
    g.quadraticCurveTo(21, 8, 23, 16);
    g.quadraticCurveTo(22, 24, 21, T);
    g.stroke();
    // Stain edge (lighter mineral deposit)
    g.strokeStyle = 'rgba(180,160,130,0.015)'; g.lineWidth = 0.4;
    g.beginPath();
    g.moveTo(23, 0);
    g.quadraticCurveTo(22, 8, 24, 16);
    g.stroke();

    // ── Nail hole (suggests something was hung here once) ──
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.beginPath(); g.arc(10, 12, 0.6, 0, Math.PI * 2); g.fill();
    // Tiny shadow below nail
    g.fillStyle = 'rgba(0,0,0,0.04)';
    g.fillRect(9.5, 12.5, 1.5, 2);

    // ── Hairline crack (between bricks, character detail) ──
    g.strokeStyle = 'rgba(15,10,5,0.06)'; g.lineWidth = 0.3;
    g.beginPath();
    g.moveTo(5, 16);
    g.quadraticCurveTo(8, 17, 12, 16.5);
    g.stroke();

    return c;
  }

  function renderWindow() {
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Outer frame (thick dark wood — 3px all sides so it reads at phone scale) ──
    g.fillStyle = '#3d2414'; g.fillRect(0, 0, T, T);
    // Frame highlight edge (top-left — light catches the frame ridge)
    g.fillStyle = 'rgba(110,70,40,0.55)';
    g.fillRect(0, 0, T, 1); g.fillRect(0, 0, 1, T);
    // Frame shadow edge (bottom-right — depth)
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, T - 1, T, 1); g.fillRect(T - 1, 0, 1, T);
    // Wood grain (just enough to read as wood)
    g.strokeStyle = 'rgba(25,12,5,0.2)'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(0, 2); g.lineTo(T, 2); g.stroke();
    g.beginPath(); g.moveTo(0, T - 2); g.lineTo(T, T - 2); g.stroke();

    // ── Dark water stain on bottom frame (rain seeps here) ──
    g.fillStyle = 'rgba(10,8,5,0.35)';
    g.fillRect(4, T - 3, T - 8, 2);

    // ── Window latch (brass, center bottom frame) ──
    g.fillStyle = '#7a6030'; g.fillRect(T / 2 - 1, T - 3, 3, 1.5);
    g.fillStyle = '#c8a020'; g.fillRect(T / 2 - 0.5, T - 3, 2, 0.5);

    // ── Inner frame bevel — WARM amber glow on interior edge ──
    // The warm cafe light wraps around the interior side of the frame
    g.fillStyle = 'rgba(255,160,60,0.22)';
    g.fillRect(3, 3, T - 6, 1);   // top inner edge warm
    g.fillRect(3, 3, 1, T - 6);   // left inner edge warm
    // Shadow on exterior side of inner bevel
    g.fillStyle = 'rgba(0,0,0,0.40)';
    g.fillRect(3, T - 4, T - 6, 1);
    g.fillRect(T - 4, 3, 1, T - 6);

    // ── Glass area — cold blue-grey night sky ──
    var gx = 4, gy = 4, gw = T - 8, gh = T - 8;
    var skyGrd = g.createLinearGradient(gx, gy, gx, gy + gh);
    skyGrd.addColorStop(0,   '#060b18');   // deep cold top
    skyGrd.addColorStop(0.4, '#0b1428');
    skyGrd.addColorStop(0.8, '#10192e');
    skyGrd.addColorStop(1,   '#14203a');   // slightly lighter at ground level
    g.fillStyle = skyGrd; g.fillRect(gx, gy, gw, gh);

    // ── Mullion — 2px thick so it reads as a divider at phone scale ──
    var midX = gx + gw / 2, midY = gy + gh / 2;
    g.fillStyle = '#3d2414';
    g.fillRect(midX - 1, gy, 2, gh);      // vertical bar
    g.fillRect(gx, midY - 1, gw, 2);      // horizontal bar
    // Mullion warm-side highlight (interior light catches left/top of bar)
    g.fillStyle = 'rgba(255,150,50,0.18)';
    g.fillRect(midX - 1, gy, 0.5, gh);
    g.fillRect(gx, midY - 1, gw, 0.5);

    // ── City silhouette — dark buildings break the cold sky ──
    g.fillStyle = '#07090f';
    g.fillRect(5, 19, 3, 6);  g.fillRect(9, 17, 2, 8);   // left pane
    g.fillRect(18, 20, 4, 5); g.fillRect(23, 18, 3, 7);   // right pane
    g.fillRect(21, 16, 2, 9);

    // Tiny lit windows in buildings (warm amber — other warm interiors out there)
    g.fillStyle = '#e8b060';
    g.fillRect(6, 21, 1, 1); g.fillRect(9, 19, 1, 1);
    g.fillRect(19, 22, 1, 1); g.fillRect(24, 20, 1, 1);
    // One cold blue window (office, TV light)
    g.fillStyle = '#80c8e8';
    g.fillRect(22, 18, 1, 1);

    // ── Rain streaks on glass — BOLD and visible at phone scale ──
    // Each streak: primary water trail + a hairline light-catch glint beside it
    var rainStreaks = [
      // [x1, y1, x2, y2, opacity, width]
      [6,  4,  5,  13, 0.55, 1.0],
      [11, 5,  10, 14, 0.45, 0.8],
      [8,  6,  7,  11, 0.38, 0.7],
      [18, 4,  17, 15, 0.58, 1.0],
      [24, 5,  23, 13, 0.48, 0.8],
      [21, 7,  20, 12, 0.35, 0.7],
      // Secondary lighter streaks for density
      [7,  15, 6,  22, 0.30, 0.6],
      [23, 16, 22, 23, 0.28, 0.6],
      [10, 17, 9,  24, 0.25, 0.5],
    ];
    for (var ri = 0; ri < rainStreaks.length; ri++) {
      var rs = rainStreaks[ri];
      // Primary water body — cool blue
      g.strokeStyle = 'rgba(160,200,230,' + rs[4] + ')';
      g.lineWidth = rs[5];
      g.beginPath(); g.moveTo(rs[0], rs[1]); g.lineTo(rs[2], rs[3]); g.stroke();
      // Light-catch glint — bright white hairline just left of streak (lamp refraction)
      g.strokeStyle = 'rgba(255,255,255,' + (rs[4] * 0.35).toFixed(2) + ')';
      g.lineWidth = 0.3;
      g.beginPath(); g.moveTo(rs[0] - 0.5, rs[1] + 1); g.lineTo(rs[2] - 0.5, rs[3] - 1); g.stroke();
    }

    // ── Water droplets at streak bottoms — teardrop shape with refraction ──
    var droplets = [
      [5, 13, 1.2, 0.50],
      [10, 14, 1.0, 0.45],
      [17, 15, 1.2, 0.52],
      [23, 13, 1.0, 0.42],
      [7, 22, 1.0, 0.35],
      [22, 23, 0.9, 0.32],
    ];
    for (var di = 0; di < droplets.length; di++) {
      var dp = droplets[di];
      // Drop body — cold blue-white with inner gradient (refraction illusion)
      var dropGrd = g.createRadialGradient(dp[0] - dp[2]*0.2, dp[1] - dp[2]*0.2, 0, dp[0], dp[1], dp[2]);
      dropGrd.addColorStop(0, 'rgba(220,240,255,' + (dp[3] * 0.9).toFixed(2) + ')');
      dropGrd.addColorStop(0.5, 'rgba(180,215,240,' + dp[3] + ')');
      dropGrd.addColorStop(1, 'rgba(140,190,220,' + (dp[3] * 0.5).toFixed(2) + ')');
      g.fillStyle = dropGrd;
      g.beginPath(); g.arc(dp[0], dp[1], dp[2], 0, Math.PI * 2); g.fill();
      // Bright specular highlight (top-left — interior lamp catch)
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath(); g.arc(dp[0] - dp[2] * 0.35, dp[1] - dp[2] * 0.35, dp[2] * 0.32, 0, Math.PI * 2); g.fill();
      // Dim dark rim at bottom (water surface tension shadow)
      g.strokeStyle = 'rgba(80,130,175,' + (dp[3] * 0.4).toFixed(2) + ')';
      g.lineWidth = 0.3;
      g.beginPath(); g.arc(dp[0], dp[1], dp[2], Math.PI * 0.3, Math.PI * 0.9); g.stroke();
    }

    // ── Condensation band at bottom of glass — warm meets cold ──
    // Deep milky haze: two-layer fog for a thick frosted-glass feel
    var fogGrd = g.createLinearGradient(gx, gy + gh - 9, gx, gy + gh);
    fogGrd.addColorStop(0,    'rgba(170,200,225,0)');
    fogGrd.addColorStop(0.35, 'rgba(175,205,228,0.18)');
    fogGrd.addColorStop(0.7,  'rgba(190,215,235,0.38)');
    fogGrd.addColorStop(1,    'rgba(210,228,245,0.55)');
    g.fillStyle = fogGrd; g.fillRect(gx, gy + gh - 9, gw, 9);
    // Second pass: warm amber tint bleeding up through the fog (interior heat)
    var fogWarmGrd = g.createLinearGradient(gx, gy + gh - 5, gx, gy + gh);
    fogWarmGrd.addColorStop(0, 'rgba(255,180,80,0)');
    fogWarmGrd.addColorStop(1, 'rgba(255,160,60,0.12)');
    g.fillStyle = fogWarmGrd; g.fillRect(gx, gy + gh - 5, gw, 5);
    // Fog upper edge — fine bright line where condensation starts (surface tension)
    g.strokeStyle = 'rgba(220,235,248,0.30)'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(gx + 1, gy + gh - 9); g.lineTo(gx + gw - 1, gy + gh - 9); g.stroke();

    // Condensation drip trails — 4 wavering runs from the fog zone
    // Each trail: wavy path + rear shadow + front bright edge + teardrop bead
    var cTrails = [
      { x: 7.5,  y0: gy+gh-8, ctrl: 8.2,  bead: 0.9 },
      { x: 13.5, y0: gy+gh-7, ctrl: 13.0, bead: 0.7 },
      { x: 20.0, y0: gy+gh-8, ctrl: 19.5, bead: 0.85},
      { x: 26.0, y0: gy+gh-6, ctrl: 26.4, bead: 0.65},
    ];
    for (var ci = 0; ci < cTrails.length; ci++) {
      var ct = cTrails[ci];
      // Shadow trail (slightly right — depth)
      g.strokeStyle = 'rgba(100,150,200,0.20)'; g.lineWidth = 1.0;
      g.beginPath();
      g.moveTo(ct.x + 0.5, ct.y0);
      g.quadraticCurveTo(ct.ctrl + 0.5, ct.y0 + (gy+gh - ct.y0)*0.5, ct.x + 0.5, gy + gh);
      g.stroke();
      // Main trail (bright cold water)
      g.strokeStyle = 'rgba(195,225,248,0.60)'; g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(ct.x, ct.y0);
      g.quadraticCurveTo(ct.ctrl, ct.y0 + (gy+gh - ct.y0)*0.5, ct.x, gy + gh);
      g.stroke();
      // Light-catch edge (hairline bright, left side of trail)
      g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 0.25;
      g.beginPath();
      g.moveTo(ct.x - 0.4, ct.y0 + 1);
      g.quadraticCurveTo(ct.ctrl - 0.4, ct.y0 + (gy+gh - ct.y0)*0.5, ct.x - 0.4, gy + gh - 1);
      g.stroke();
      // Teardrop bead (hanging at trail bottom — surface tension pulls it round)
      var bx = ct.x, by = gy + gh - 0.5, br = ct.bead;
      var beadGrd = g.createRadialGradient(bx - br*0.3, by - br*0.3, 0, bx, by, br * 1.2);
      beadGrd.addColorStop(0, 'rgba(230,248,255,0.80)');
      beadGrd.addColorStop(0.5,'rgba(190,225,248,0.65)');
      beadGrd.addColorStop(1,  'rgba(140,190,225,0.20)');
      g.fillStyle = beadGrd;
      g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
      // Specular dot on bead
      g.fillStyle = 'rgba(255,255,255,0.80)';
      g.beginPath(); g.arc(bx - br*0.3, by - br*0.3, br * 0.28, 0, Math.PI * 2); g.fill();
    }

    // ── Street lamp in left pane — lens flare upgrade ──
    // Post
    g.strokeStyle = '#151c28'; g.lineWidth = 0.7;
    g.beginPath(); g.moveTo(12, 15); g.lineTo(12, 24); g.stroke();

    // Layer 1: wide diffuse halo (rain-scattering the light outward)
    var lampHalo = g.createRadialGradient(12, 15, 0, 12, 15, 9);
    lampHalo.addColorStop(0,   'rgba(255,210,130,0.30)');
    lampHalo.addColorStop(0.35,'rgba(255,195,90, 0.14)');
    lampHalo.addColorStop(0.70,'rgba(255,175,60, 0.05)');
    lampHalo.addColorStop(1,   'rgba(0,0,0,0)');
    g.fillStyle = lampHalo; g.fillRect(3, 6, 18, 18);

    // Layer 2: rain-haze ring — light scatters into a blue-white annulus through wet air
    g.save();
    g.globalAlpha = 0.18;
    g.strokeStyle = 'rgba(200,230,255,1)';
    g.lineWidth = 0.6;
    g.beginPath(); g.arc(12, 15, 4.2, 0, Math.PI * 2); g.stroke();
    // outer soft ring edge
    g.globalAlpha = 0.07;
    g.lineWidth = 1.2;
    g.beginPath(); g.arc(12, 15, 5.5, 0, Math.PI * 2); g.stroke();
    g.restore();

    // Layer 3: cobblestone wet-ground bleed — elliptical amber pool below lamp
    var cobblePool = g.createRadialGradient(12, 22, 0, 12, 22, 5);
    cobblePool.addColorStop(0,   'rgba(255,200,80,0.22)');
    cobblePool.addColorStop(0.5, 'rgba(255,180,50,0.08)');
    cobblePool.addColorStop(1,   'rgba(0,0,0,0)');
    g.save();
    g.scale(1, 0.45); // flatten into horizontal ellipse
    g.fillStyle = cobblePool; g.fillRect(7, 44, 10, 11); // y coords scaled by 1/0.45
    g.restore();

    // Layer 4: amber lamp disc — the actual bulb surface
    var bulbGrd = g.createRadialGradient(11.5, 14.5, 0, 12, 15, 1.4);
    bulbGrd.addColorStop(0,   'rgba(255,255,220,0.95)'); // white-hot center
    bulbGrd.addColorStop(0.40,'rgba(255,220,120,0.90)'); // amber mid
    bulbGrd.addColorStop(1,   'rgba(255,185,60, 0.60)'); // warm amber edge
    g.fillStyle = bulbGrd;
    g.beginPath(); g.arc(12, 15, 1.4, 0, Math.PI * 2); g.fill();

    // Layer 5: hard white-hot specular core (lens flare bright point)
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.beginPath(); g.arc(11.7, 14.7, 0.45, 0, Math.PI * 2); g.fill();

    // Layer 6: lens flare spike — faint diagonal streak across left pane glass
    // Mimics the airy-disk spike a wet window lens creates
    g.save();
    g.globalAlpha = 0.10;
    g.strokeStyle = 'rgba(255,230,160,1)';
    g.lineWidth = 0.4;
    // main 45° spike
    g.beginPath(); g.moveTo(8, 11); g.lineTo(16, 19); g.stroke();
    // counter-spike (opposite direction, dimmer)
    g.globalAlpha = 0.05;
    g.beginPath(); g.moveTo(16, 11); g.lineTo(8, 19); g.stroke();
    g.restore();

    // ── Stars (small but 1px so they register) ──
    g.fillStyle = 'rgba(255,255,255,0.50)';
    g.fillRect(7, 6, 1, 1);
    g.fillRect(11, 5, 1, 1);
    g.fillRect(20, 6, 1, 1);
    g.fillRect(25, 5, 1, 1);

    // ── Glass sheen — single diagonal glint across both upper panes ──
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(gx + 1, gy + 1); g.lineTo(gx + 8, gy + 8); g.stroke();
    g.beginPath(); g.moveTo(midX + 2, gy + 1); g.lineTo(midX + 9, gy + 8); g.stroke();

    // ── Interior warmth wash on glass — amber tint on the inner glass face ──
    // Gradient from bottom (floor warmth) fading up (glass gets colder higher)
    var warmGrd = g.createLinearGradient(gx, gy + gh, gx, gy);
    warmGrd.addColorStop(0,   'rgba(255,160,60,0.13)');
    warmGrd.addColorStop(0.5, 'rgba(255,140,40,0.06)');
    warmGrd.addColorStop(1,   'rgba(255,120,30,0)');
    g.fillStyle = warmGrd; g.fillRect(gx, gy, gw, gh);

    return c;
  }

  function renderCounter() {
    // Counter TOP surface (row 2) — seen from slightly above
    // Rich walnut/mahogany surface with lacquer sheen and espresso history
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Base: deep walnut — warmer and richer than before ──
    g.fillStyle = '#4e3020'; g.fillRect(0, 0, T, T);

    // ── Walnut heartwood mid-tone wash — darkens center, lighter near near edge ──
    var heartGrd = g.createLinearGradient(0, 0, T, T);
    heartGrd.addColorStop(0,   '#57361f');
    heartGrd.addColorStop(0.45,'#4a2c1a');  // dark heartwood band
    heartGrd.addColorStop(0.7, '#543320');
    heartGrd.addColorStop(1,   '#5a3826');
    g.fillStyle = heartGrd; g.fillRect(0, 0, T, T);

    // ── Horizontal wood grain — richer, alternating light/dark streaks ──
    for (var i = 0; i < T; i += 1) {
      var wave = Math.sin(i * 1.1 + 0.3) * Math.sin(i * 0.37 + 1.2);
      var alpha, r, gv, b;
      if (wave > 0.05) {
        // Light sapwood streak
        alpha = wave * 0.18;
        g.strokeStyle = 'rgba(180,110,55,' + alpha.toFixed(3) + ')';
      } else if (wave < -0.05) {
        // Dark heartwood shadow streak
        alpha = (-wave) * 0.22;
        g.strokeStyle = 'rgba(25,10,3,' + alpha.toFixed(3) + ')';
      } else {
        continue; // skip near-zero — avoids grey mud
      }
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, i); g.lineTo(T, i); g.stroke();
    }

    // ── Medullary rays — short diagonal flecks (characteristic of walnut) ──
    g.lineWidth = 0.4;
    var rays = [[4,6,9,8],[14,3,19,5],[22,15,27,13],[7,21,11,20],[25,8,29,10],[2,17,6,16],[17,24,21,22]];
    for (var ri = 0; ri < rays.length; ri++) {
      var rx = rays[ri];
      g.strokeStyle = 'rgba(200,140,70,0.09)';
      g.beginPath(); g.moveTo(rx[0],rx[1]); g.lineTo(rx[2],rx[3]); g.stroke();
      g.strokeStyle = 'rgba(255,200,130,0.05)';
      g.beginPath(); g.moveTo(rx[0],rx[1]+0.5); g.lineTo(rx[2],rx[3]+0.5); g.stroke();
    }

    // ── Knot cluster — dark swirling organic feature ──
    // Outer ring halo
    g.strokeStyle = 'rgba(30,15,5,0.18)'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(21, 13, 4.5, 2.5, 0.35, 0, Math.PI * 2); g.stroke();
    // Inner dark knot core
    g.fillStyle = 'rgba(20,8,2,0.22)';
    g.beginPath(); g.ellipse(21, 13, 2.5, 1.5, 0.35, 0, Math.PI * 2); g.fill();
    // Knot light side (grain bends around it)
    g.strokeStyle = 'rgba(160,95,40,0.10)'; g.lineWidth = 0.5;
    g.beginPath(); g.ellipse(21, 13, 3.5, 2, 0.35, 0, Math.PI * 1.1); g.stroke();

    // ── Espresso ring stains — multiple overlapping, visible at a glance ──
    // Main fresh ring (dark, wet-looking)
    g.strokeStyle = 'rgba(40,20,8,0.28)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(10, 11, 3.2, 0, Math.PI * 2); g.stroke();
    // Inner lighter fill of same ring (dried residue)
    g.strokeStyle = 'rgba(90,55,25,0.10)'; g.lineWidth = 0.5;
    g.beginPath(); g.arc(10, 11, 2.6, 0, Math.PI * 2); g.stroke();
    // Older fainter ring (partial arc, rubbed away)
    g.strokeStyle = 'rgba(55,35,15,0.18)'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(24, 19, 2.8, 0.2, Math.PI * 1.7); g.stroke();
    // Milk ring ghost (lighter deposit, almost dry)
    g.strokeStyle = 'rgba(210,180,130,0.08)'; g.lineWidth = 0.6;
    g.beginPath(); g.arc(24, 19, 3.5, 0.5, Math.PI * 1.4); g.stroke();
    // Tiny espresso drip spot (fresh-ish)
    g.fillStyle = 'rgba(30,12,4,0.20)';
    g.beginPath(); g.arc(13, 20, 0.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(30,12,4,0.10)';
    g.beginPath(); g.arc(13, 20, 1.6, 0, Math.PI * 2); g.fill();

    // ── Drip mat zone (rubber mat texture near the machine end) ──
    // Mat base — slightly cooler/darker strip
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 4, 12, T - 8);
    // Mat grid holes — tiny dark dots in a regular grid
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (var mx = 1.5; mx < 11; mx += 2.5) {
      for (var my = 6; my < T - 5; my += 2.5) {
        g.beginPath(); g.arc(mx, my, 0.45, 0, Math.PI * 2); g.fill();
      }
    }
    // Mat border highlight (raised edge of mat)
    g.strokeStyle = 'rgba(140,100,60,0.12)'; g.lineWidth = 0.5;
    g.strokeRect(0.5, 4.5, 11, T - 10);

    // ── Sugar & crumb scatter ──
    g.fillStyle = 'rgba(255,252,235,0.18)';
    g.fillRect(16, 7, 1, 1);
    g.fillRect(27, 14, 1, 1);
    g.fillStyle = 'rgba(255,252,235,0.10)';
    g.fillRect(20, 22, 1, 1);
    // Tiny crumb (darker)
    g.fillStyle = 'rgba(140,90,40,0.20)';
    g.fillRect(8, 24, 1.2, 0.8);

    // ── Fine scratch marks (years of service) ──
    g.strokeStyle = 'rgba(0,0,0,0.07)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(3, 7); g.lineTo(12, 9); g.stroke();
    g.beginPath(); g.moveTo(18, 22); g.lineTo(28, 21); g.stroke();
    g.strokeStyle = 'rgba(200,145,80,0.06)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(15, 5); g.lineTo(25, 6); g.stroke();

    // ── Lacquer sheen — strong horizontal gloss streak near the top edge ──
    // Primary gloss band (top third of tile — the lacquer catches overhead light)
    var sheenTop = g.createLinearGradient(0, 1, 0, T * 0.42);
    sheenTop.addColorStop(0,   'rgba(255,240,200,0.38)');  // bright rim highlight
    sheenTop.addColorStop(0.12,'rgba(255,230,180,0.22)');
    sheenTop.addColorStop(0.35,'rgba(255,210,150,0.10)');
    sheenTop.addColorStop(1,   'rgba(255,200,130,0)');
    g.fillStyle = sheenTop; g.fillRect(0, 0, T, T);

    // Secondary soft gloss (mid-surface bounce — slightly off-centre)
    var sheenMid = g.createLinearGradient(0, T * 0.38, 0, T * 0.58);
    sheenMid.addColorStop(0,   'rgba(255,225,170,0)');
    sheenMid.addColorStop(0.4, 'rgba(255,230,185,0.09)');
    sheenMid.addColorStop(0.6, 'rgba(255,255,255,0.06)');
    sheenMid.addColorStop(1,   'rgba(255,225,170,0)');
    g.fillStyle = sheenMid; g.fillRect(0, 0, T, T);

    // ── Edison bulb reflection — warmer, more pronounced elliptical pool ──
    var bulbReflect = g.createRadialGradient(T * 0.38, T * 0.35, 0, T * 0.38, T * 0.35, T * 0.55);
    bulbReflect.addColorStop(0, 'rgba(255,210,130,0.14)');
    bulbReflect.addColorStop(0.4,'rgba(255,185,100,0.06)');
    bulbReflect.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bulbReflect; g.fillRect(0, 0, T, T);

    // ── Left-side lamp pool (secondary Edison above left of counter) ──
    var lamp2 = g.createRadialGradient(T * 0.78, T * 0.28, 0, T * 0.78, T * 0.28, T * 0.40);
    lamp2.addColorStop(0, 'rgba(255,200,110,0.10)');
    lamp2.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lamp2; g.fillRect(0, 0, T, T);

    // ── Front edge — routed ogee profile with lacquer lip ──
    // Ogee top chamfer (catches overhead light — now brighter, lacquer edge)
    g.fillStyle = '#b08c60'; g.fillRect(0, T - 4, T, 1);
    g.fillStyle = 'rgba(255,220,150,0.42)'; g.fillRect(0, T - 4, T, 0.6);  // lacquer specular on lip
    // Ogee concave curve (shadow band — the routed groove)
    g.fillStyle = '#62473a'; g.fillRect(0, T - 3, T, 1);
    g.fillStyle = 'rgba(0,0,0,0.20)'; g.fillRect(0, T - 3, T, 0.7);
    // Ogee convex belly (catches light again)
    g.fillStyle = '#8d6e50'; g.fillRect(0, T - 2, T, 1);
    var edgeShine = g.createLinearGradient(0, T - 2, 0, T - 1);
    edgeShine.addColorStop(0,   'rgba(230,185,110,0.32)');
    edgeShine.addColorStop(0.5, 'rgba(255,230,170,0.20)');
    edgeShine.addColorStop(1,   'rgba(150,105,60,0.12)');
    g.fillStyle = edgeShine; g.fillRect(0, T - 2, T, 1);
    // Bottom drip shadow (undercut where edge meets front panel)
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, T - 1, T, 1);
    // Edge cross-cut grain on front lip
    g.strokeStyle = 'rgba(110,75,40,0.10)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(0, T - 2.5); g.lineTo(T, T - 2.5); g.stroke();
    // Tiny nick in edge (worn from heavy use)
    g.fillStyle = 'rgba(120,90,55,0.22)';
    g.fillRect(18, T - 4, 2.5, 1);
    g.fillStyle = 'rgba(220,170,100,0.12)';
    g.fillRect(18, T - 4, 2.5, 0.4);

    return c;
  }

  function renderCounterFront() {
    // Counter FRONT panel (row 3) — vertical face towards customers
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Base: dark stained wood — slightly warmer mid-tone so it reads off the floor ──
    g.fillStyle = '#4a3224'; g.fillRect(0, 0, T, T);

    // ── Vertical wood grain (richer variation, alternating dark/light streaks) ──
    for (var i = 0; i < T; i += 1) {
      var grain = Math.sin(i * 1.7 + 0.5) * Math.sin(i * 0.4);
      var alpha = grain > 0
        ? 0.07 * grain   // light streak
        : 0.09 * (-grain); // dark streak
      g.strokeStyle = grain > 0
        ? 'rgba(255,180,100,' + alpha.toFixed(3) + ')'
        : 'rgba(0,0,0,' + alpha.toFixed(3) + ')';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, T); g.stroke();
    }

    // ── Panel molding: raised-frame look (recessed centre flanked by proud edges) ──
    // Outer shadow (inset frame creates depth)
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, 5, 2, T - 8);          // left shadow strip
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(T - 2, 5, 2, T - 8);      // right shadow strip
    // Outer highlight (proud edge catches pendant glow)
    g.fillStyle = 'rgba(255,180,90,0.12)'; g.fillRect(0, 5, 1, T - 8);
    g.fillStyle = 'rgba(255,180,90,0.07)'; g.fillRect(T - 1, 5, 1, T - 8);

    // ── Three planks with crisp visible joints ──
    var joints = [10, 21];
    for (var j = 0; j < joints.length; j++) {
      // Groove shadow (2px wide)
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(joints[j], 4, 1.5, T - 7);
      // Bright edge highlight to the right of groove (wood face edge)
      g.fillStyle = 'rgba(190,130,70,0.18)'; g.fillRect(joints[j] + 1.5, 4, 1, T - 7);
    }

    // ── Horizontal panel rail system (more pronounced, 3 rails) ──
    // Rail 1 — upper (just below overhang, catches pendant light strongly)
    g.fillStyle = '#3a2418'; g.fillRect(0, 6, T, 2.5);                        // recessed dark band
    g.fillStyle = 'rgba(255,190,100,0.22)'; g.fillRect(0, 6, T, 1);           // warm pendant glow on top of rail
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 8.5, T, 1);               // shadow under rail
    // Rail 2 — mid (decorative divider)
    g.fillStyle = '#3a2418'; g.fillRect(0, 16, T, 2);
    g.fillStyle = 'rgba(255,170,80,0.12)'; g.fillRect(0, 16, T, 0.8);
    g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(0, 18, T, 0.8);
    // Rail 3 — lower (above brass foot rail)
    g.fillStyle = '#3a2418'; g.fillRect(0, T - 10, T, 2);
    g.fillStyle = 'rgba(255,160,70,0.10)'; g.fillRect(0, T - 10, T, 0.8);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, T - 8, T, 0.8);

    // ── Brass foot rail (near bottom) ──
    var railY = T - 7;
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, railY + 1.5, T, 2.5);     // rail shadow
    g.fillStyle = '#8b7340'; g.fillRect(0, railY, T, 2.5);                    // rail body
    g.fillStyle = '#c8a820'; g.fillRect(0, railY, T, 1);                      // bright highlight top
    g.fillStyle = 'rgba(255,230,150,0.3)'; g.fillRect(4, railY, 8, 0.6);      // specular hotspot 1
    g.fillStyle = 'rgba(255,230,150,0.22)'; g.fillRect(18, railY, 6, 0.6);    // specular hotspot 2
    // Rail brackets
    g.fillStyle = '#5a4420';
    g.fillRect(3, railY - 1, 2, 4.5);
    g.fillRect(15, railY - 1, 2, 4.5);
    g.fillRect(27, railY - 1, 2, 4.5);
    // Bracket highlight
    g.fillStyle = 'rgba(255,200,100,0.1)';
    g.fillRect(3, railY - 1, 1, 4.5);
    g.fillRect(15, railY - 1, 1, 4.5);
    g.fillRect(27, railY - 1, 1, 4.5);

    // ── Pendant lamp warm light reflection on upper face ──
    // Primary glow band — top 8px catches direct pendant light from above
    var pendantGlow = g.createLinearGradient(0, 0, 0, 9);
    pendantGlow.addColorStop(0, 'rgba(255,200,110,0.32)');
    pendantGlow.addColorStop(0.4, 'rgba(240,170,80,0.15)');
    pendantGlow.addColorStop(1, 'rgba(200,130,50,0)');
    g.fillStyle = pendantGlow; g.fillRect(0, 0, T, 9);

    // Pendant hotspot pools (where individual bulbs above shine down and slightly forward)
    var hotspots = [T * 0.22, T * 0.62];
    for (var h = 0; h < hotspots.length; h++) {
      var hs = g.createRadialGradient(hotspots[h], 0, 0, hotspots[h], 4, T * 0.55);
      hs.addColorStop(0, 'rgba(255,220,140,0.20)');
      hs.addColorStop(0.4, 'rgba(255,190,90,0.08)');
      hs.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = hs; g.fillRect(0, 0, T, T);
    }

    // ── Top overhang lip (counter surface above casts hard shadow then warm bounce) ──
    var topShadow = g.createLinearGradient(0, 0, 0, 7);
    topShadow.addColorStop(0, 'rgba(0,0,0,0.55)');
    topShadow.addColorStop(0.5, 'rgba(0,0,0,0.2)');
    topShadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = topShadow; g.fillRect(0, 0, T, 7);
    // Overhang lip — visible edge of counter surface
    g.fillStyle = '#7a5540'; g.fillRect(0, 0, T, 2);
    g.fillStyle = 'rgba(255,210,150,0.25)'; g.fillRect(0, 0, T, 1);  // warm rim highlight

    // ── Bottom edge (merges into dark floor but with a distinct terminator line) ──
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, T - 2, T, 2);
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, T - 4, T, 2);

    // ── Small chalkboard menu (hung between upper and mid rail) ──
    var cbL = 5, cbT = 10, cbW = 12, cbH = 8;
    // Board shadow
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(cbL + 0.5, cbT + 0.5, cbW, cbH);
    // Board frame (thin warm wood)
    g.fillStyle = '#6a4530'; g.fillRect(cbL - 1, cbT - 1, cbW + 2, cbH + 2);
    // Frame highlight (pendant catches top edge)
    g.fillStyle = 'rgba(255,190,100,0.15)'; g.fillRect(cbL - 1, cbT - 1, cbW + 2, 1);
    // Chalk surface
    g.fillStyle = '#192820'; g.fillRect(cbL, cbT, cbW, cbH);
    // "MENU" header
    g.fillStyle = 'rgba(245,240,225,0.60)';
    // M
    g.fillRect(cbL + 1.5, cbT + 1.5, 0.6, 1.8);
    g.fillRect(cbL + 1.8, cbT + 1.5, 0.6, 0.6);
    g.fillRect(cbL + 2.6, cbT + 1.8, 0.6, 0.6);
    g.fillRect(cbL + 3.2, cbT + 1.5, 0.6, 1.8);
    // E
    g.fillRect(cbL + 4.2, cbT + 1.5, 0.6, 1.8);
    g.fillRect(cbL + 4.2, cbT + 1.5, 1.5, 0.5);
    g.fillRect(cbL + 4.2, cbT + 2.1, 1.2, 0.4);
    g.fillRect(cbL + 4.2, cbT + 2.8, 1.5, 0.5);
    // N
    g.fillRect(cbL + 6.2, cbT + 1.5, 0.6, 1.8);
    g.fillRect(cbL + 6.5, cbT + 1.5, 0.5, 0.5);
    g.fillRect(cbL + 6.8, cbT + 2, 0.5, 0.5);
    g.fillRect(cbL + 7.4, cbT + 1.5, 0.6, 1.8);
    // U
    g.fillRect(cbL + 8.4, cbT + 1.5, 0.6, 1.6);
    g.fillRect(cbL + 8.4, cbT + 2.8, 1.8, 0.5);
    g.fillRect(cbL + 9.6, cbT + 1.5, 0.6, 1.6);
    // Wavy underline
    g.strokeStyle = 'rgba(240,230,200,0.28)'; g.lineWidth = 0.4;
    g.beginPath();
    g.moveTo(cbL + 1, cbT + 3.6);
    g.quadraticCurveTo(cbL + 4, cbT + 3.2, cbL + 6, cbT + 3.6);
    g.quadraticCurveTo(cbL + 8, cbT + 4, cbL + 10.5, cbT + 3.5);
    g.stroke();
    // Menu items
    g.fillStyle = 'rgba(240,235,220,0.32)';
    g.fillRect(cbL + 1, cbT + 4.5, 5, 0.5);
    g.fillStyle = 'rgba(240,235,220,0.16)';
    g.fillRect(cbL + 6.5, cbT + 4.8, 0.4, 0.4);
    g.fillRect(cbL + 7.5, cbT + 4.8, 0.4, 0.4);
    g.fillStyle = 'rgba(240,235,220,0.32)';
    g.fillRect(cbL + 8.5, cbT + 4.5, 2, 0.5);
    g.fillStyle = 'rgba(240,235,220,0.26)';
    g.fillRect(cbL + 1, cbT + 6, 4, 0.5);
    g.fillStyle = 'rgba(240,235,220,0.14)';
    g.fillRect(cbL + 5.5, cbT + 6.3, 0.4, 0.4);
    g.fillRect(cbL + 6.5, cbT + 6.3, 0.4, 0.4);
    g.fillStyle = 'rgba(240,235,220,0.26)';
    g.fillRect(cbL + 7.5, cbT + 6, 2.5, 0.5);
    // Chalk dust + star
    g.fillStyle = 'rgba(200,200,190,0.07)'; g.fillRect(cbL + 7, cbT + 4, 4, 2);
    g.fillStyle = 'rgba(230,225,210,0.09)';
    g.fillRect(cbL + 2, cbT + 7, 0.5, 0.5);
    g.fillRect(cbL + 5, cbT + 7.2, 0.4, 0.4);
    g.fillRect(cbL + 8, cbT + 7, 0.6, 0.3);
    g.strokeStyle = 'rgba(255,220,100,0.22)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(cbL + 0.5, cbT + 1.8); g.lineTo(cbL + 1.2, cbT + 2.5); g.stroke();
    g.beginPath(); g.moveTo(cbL + 0.5, cbT + 2.5); g.lineTo(cbL + 1.2, cbT + 1.8); g.stroke();
    // Hanging wire
    g.strokeStyle = 'rgba(100,80,60,0.35)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(cbL + cbW / 2, cbT - 1); g.lineTo(cbL + cbW / 2, cbT - 3); g.stroke();

    // ── Glass tip jar (right of chalkboard) ──
    var tjL = 20, tjT = 12, tjW = 6, tjH = 7;
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(tjL + 0.5, tjT + 0.5, tjW, tjH);
    g.fillStyle = 'rgba(180,210,200,0.18)'; g.fillRect(tjL, tjT, tjW, tjH);
    g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(tjL, tjT, 0.5, tjH);
    g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(tjL + tjW - 0.5, tjT, 0.5, tjH);
    // Rim catches pendant warm light
    g.fillStyle = 'rgba(255,210,130,0.25)'; g.fillRect(tjL - 0.5, tjT, tjW + 1, 1);
    g.fillStyle = 'rgba(180,140,60,0.38)';
    g.beginPath(); g.arc(tjL + 1.5, tjT + tjH - 2, 1, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(tjL + 3.5, tjT + tjH - 1.5, 1, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(160,170,180,0.32)';
    g.beginPath(); g.arc(tjL + 2.5, tjT + tjH - 3, 0.8, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(tjL + 4.5, tjT + tjH - 2.5, 0.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(80,140,80,0.32)'; g.fillRect(tjL + 1, tjT - 1.5, 3, 2);
    g.fillStyle = 'rgba(100,160,100,0.22)'; g.fillRect(tjL + 1, tjT - 1.5, 3, 0.5);
    g.fillStyle = 'rgba(60,40,30,0.22)'; g.fillRect(tjL + 1, tjT + 2, 4, 0.5);

    // ── Small napkin holder ──
    var nhL = 1, nhT = 19, nhW = 4, nhH = 3;
    g.fillStyle = '#3a3a3a'; g.fillRect(nhL, nhT, nhW, nhH);
    g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(nhL, nhT, nhW, 0.5);
    g.fillStyle = 'rgba(245,240,230,0.38)'; g.fillRect(nhL + 0.5, nhT + 0.5, nhW - 1, nhH - 1);
    g.strokeStyle = 'rgba(200,195,185,0.18)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(nhL + 1, nhT + 1.2); g.lineTo(nhL + nhW - 1, nhT + 1.2); g.stroke();
    g.beginPath(); g.moveTo(nhL + 1, nhT + 1.8); g.lineTo(nhL + nhW - 1, nhT + 1.8); g.stroke();

    // ── Final ambient warm fill (Edison / pendant atmosphere) ──
    var warmGlow = g.createRadialGradient(T / 2, 2, 0, T / 2, T * 0.4, T * 0.9);
    warmGlow.addColorStop(0, 'rgba(220,160,80,0.12)');
    warmGlow.addColorStop(0.45, 'rgba(200,130,60,0.05)');
    warmGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = warmGlow; g.fillRect(0, 0, T, T);

    return c;
  }

  function renderBookshelf() {
    var c = makeCanvas(), g = c.getContext('2d');
    // Deep mahogany back panel
    g.fillStyle = '#2a1810'; g.fillRect(0, 0, T, T);
    // Subtle wood grain on back
    for (var gi = 0; gi < T; gi += 3) {
      g.strokeStyle = 'rgba(60,35,20,' + (0.04 + Math.sin(gi * 0.8) * 0.02).toFixed(3) + ')';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(gi, 0); g.lineTo(gi, T); g.stroke();
    }

    // Frame — ornate dark wood border with carved detail
    // Base frame color
    g.fillStyle = '#4a3020';
    g.fillRect(0, 0, 3, T); g.fillRect(T - 3, 0, 3, T);
    g.fillRect(0, 0, T, 3); g.fillRect(0, T - 3, T, 3);
    // Outer edge shadow (recessed into wall)
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(0, 0, 1, T); g.fillRect(0, 0, T, 1);
    // Outer edge light (bottom-right catches ambient)
    g.fillStyle = 'rgba(120,85,50,0.1)';
    g.fillRect(T - 1, 0, 1, T); g.fillRect(0, T - 1, T, 1);
    // Inner frame routed groove (dark channel between frame and interior)
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(2, 2, T - 4, 1); g.fillRect(2, 2, 1, T - 4);
    g.fillRect(2, T - 3, T - 4, 1); g.fillRect(T - 3, 2, 1, T - 4);
    // Inner frame highlight (light catching the routed edge)
    g.fillStyle = 'rgba(160,120,70,0.15)';
    g.fillRect(3, 3, T - 6, 0.5); g.fillRect(3, 3, 0.5, T - 6);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(3, T - 3.5, T - 6, 0.5); g.fillRect(T - 3.5, 3, 0.5, T - 6);
    // Vertical wood grain on frame sides
    g.strokeStyle = 'rgba(60,38,20,0.1)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(1.2, 3); g.lineTo(1.2, T - 3); g.stroke();
    g.beginPath(); g.moveTo(T - 1.2, 3); g.lineTo(T - 1.2, T - 3); g.stroke();
    // Horizontal grain on top/bottom
    g.beginPath(); g.moveTo(3, 1.2); g.lineTo(T - 3, 1.2); g.stroke();
    g.beginPath(); g.moveTo(3, T - 1.2); g.lineTo(T - 3, T - 1.2); g.stroke();
    // Corner rosettes (carved floral detail at 4 corners)
    var corners = [[1.5, 1.5], [T - 1.5, 1.5], [1.5, T - 1.5], [T - 1.5, T - 1.5]];
    for (var ci = 0; ci < corners.length; ci++) {
      var ccx = corners[ci][0], ccy = corners[ci][1];
      // Tiny carved circle (rosette base)
      g.strokeStyle = 'rgba(80,55,30,0.2)'; g.lineWidth = 0.3;
      g.beginPath(); g.arc(ccx, ccy, 1.2, 0, Math.PI * 2); g.stroke();
      // Center dot
      g.fillStyle = 'rgba(100,70,40,0.15)';
      g.beginPath(); g.arc(ccx, ccy, 0.4, 0, Math.PI * 2); g.fill();
      // 4 tiny petal marks
      g.fillStyle = 'rgba(80,55,30,0.1)';
      g.fillRect(ccx - 0.2, ccy - 1.2, 0.4, 0.5);
      g.fillRect(ccx - 0.2, ccy + 0.7, 0.4, 0.5);
      g.fillRect(ccx - 1.2, ccy - 0.2, 0.5, 0.4);
      g.fillRect(ccx + 0.7, ccy - 0.2, 0.5, 0.4);
    }
    // Crown molding detail (decorative bead along top frame)
    g.fillStyle = 'rgba(100,70,40,0.08)';
    for (var bdi = 0; bdi < 6; bdi++) {
      g.beginPath(); g.arc(5 + bdi * 4, 1.5, 0.5, 0, Math.PI * 2); g.fill();
    }

    // 3 shelves with proper depth
    var shelfYs = [9, 18, 27]; // shelf plank Y positions
    var bookZones = [
      { top: 3, bottom: 9, h: 6 },    // top shelf
      { top: 11, bottom: 18, h: 7 },   // middle shelf (tallest)
      { top: 20, bottom: 27, h: 7 },   // bottom shelf
    ];
    // Muted, sophisticated book colors
    var bookColors = [
      '#6b2222', '#1e3d5c', '#2d4a2d', '#7a5c1e', '#4a2060',
      '#8c4a28', '#2a4848', '#5c3040', '#3a5028', '#6e4830',
    ];

    for (var si = 0; si < 3; si++) {
      var zone = bookZones[si];
      // Shelf plank (layered for depth)
      var sy = shelfYs[si], sw = T - 6;
      // Plank base (dark underside visible as front edge)
      g.fillStyle = '#4a3020';
      g.fillRect(3, sy, sw, 2);
      // Plank top surface (lighter — catches light from above)
      g.fillStyle = '#5a3d28';
      g.fillRect(3, sy, sw, 1.5);
      // Wood grain on shelf (horizontal lines, subtle)
      g.strokeStyle = 'rgba(80,55,30,0.12)'; g.lineWidth = 0.3;
      g.beginPath(); g.moveTo(4, sy + 0.5); g.lineTo(T - 4, sy + 0.5); g.stroke();
      g.strokeStyle = 'rgba(40,25,12,0.08)'; g.lineWidth = 0.3;
      g.beginPath(); g.moveTo(4, sy + 1.2); g.lineTo(T - 4, sy + 1.2); g.stroke();
      // Plank top highlight (warm light from above)
      g.fillStyle = 'rgba(180,140,90,0.18)';
      g.fillRect(3, sy, sw, 0.6);
      // Front edge bevel (light catches the lip)
      g.fillStyle = 'rgba(160,120,70,0.1)';
      g.fillRect(3, sy + 1.5, sw, 0.5);
      // Front edge shadow (bottom of plank)
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(3, sy + 1.8, sw, 0.3);
      // Bracket supports (L-shaped metal, 2 per shelf)
      var bracketXs = [6, T - 9];
      for (var bi = 0; bi < bracketXs.length; bi++) {
        var bkx = bracketXs[bi];
        // Vertical bracket arm (under shelf, visible in gap between books)
        g.fillStyle = '#3a2a1c';
        g.fillRect(bkx, sy + 2, 1, 2);
        // Horizontal bracket arm (along shelf bottom)
        g.fillRect(bkx, sy + 1.8, 2.5, 0.5);
        // Bracket screw (tiny dot)
        g.fillStyle = 'rgba(120,90,50,0.2)';
        g.beginPath(); g.arc(bkx + 0.5, sy + 3, 0.3, 0, Math.PI * 2); g.fill();
      }
      // Under-shelf shadow (cast onto books below)
      if (si < 2) {
        var shelfShadow = g.createLinearGradient(0, sy + 2, 0, sy + 5);
        shelfShadow.addColorStop(0, 'rgba(0,0,0,0.28)');
        shelfShadow.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = shelfShadow;
        g.fillRect(3, sy + 2, sw, 3);
      }

      // Books on this shelf
      var bx = 4;
      var maxH = zone.h;
      while (bx < T - 4) {
        var bw = 2 + ((bx * 3 + si * 11) % 3); // 2-4px wide
        if (bx + bw > T - 4) break;
        var bh = maxH - 1 + ((bx * 7 + si * 5) % 3) - 1; // vary height
        var bci = ((bx + si * 3) * 7 + si) % bookColors.length;
        var by = zone.bottom - bh;

        // Book body
        g.fillStyle = bookColors[bci];
        g.fillRect(bx, by, bw, bh);

        // Spine highlight (left edge catches light)
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.fillRect(bx, by, 1, bh);
        // Spine shadow (right edge)
        g.fillStyle = 'rgba(0,0,0,0.15)';
        g.fillRect(bx + bw - 1, by, 1, bh);
        // Top edge
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(bx, by, bw, 1);

        // Gold lettering hint on some spines (every 3rd book)
        if ((bx + si) % 9 < 3 && bh >= 5) {
          g.fillStyle = 'rgba(212,170,80,0.25)';
          g.fillRect(bx + 1, by + Math.floor(bh * 0.3), bw - 2, 1);
          if (bh >= 6) g.fillRect(bx + 1, by + Math.floor(bh * 0.6), bw - 2, 1);
        }

        // Spine band gilding (gold lines at top and bottom of spine)
        if ((bx + si * 4) % 7 < 2 && bh >= 4) {
          g.fillStyle = 'rgba(200,170,80,0.18)';
          g.fillRect(bx, by + 1, bw, 0.4);          // top band
          g.fillRect(bx, by + bh - 1.5, bw, 0.4);   // bottom band
        }

        // Bookmark ribbon peeking out top (every ~5th book)
        if ((bx * 11 + si * 7) % 13 < 2 && bh >= 5) {
          var ribbonColors = ['#c03030', '#2060a0', '#d4a020', '#4a8040'];
          var rc = ribbonColors[((bx + si) * 3) % ribbonColors.length];
          g.fillStyle = rc;
          // Ribbon extends 1.5px above book top
          g.fillRect(bx + Math.floor(bw / 2), by - 1.5, 0.6, 2);
          // Ribbon forked tail tip
          g.fillRect(bx + Math.floor(bw / 2) - 0.3, by - 1.5, 0.4, 0.4);
          g.fillRect(bx + Math.floor(bw / 2) + 0.5, by - 1.5, 0.4, 0.4);
        }

        // Pulled-out book (one per shelf, offset forward by 1px)
        if ((bx * 3 + si * 17) % 19 === 0 && bh >= 4) {
          // Redraw this book 1px forward (lighter face visible)
          g.fillStyle = 'rgba(255,240,220,0.06)';
          g.fillRect(bx, by, bw, bh); // slightly lighter overlay = "closer"
          // Page edges visible (thin white strip at top)
          g.fillStyle = 'rgba(240,235,225,0.15)';
          g.fillRect(bx + 0.5, by, bw - 1, 0.6);
        }

        // Occasional leaning book (slight offset)
        bx += bw + ((bx * 13 + si) % 5 === 0 ? 2 : 1);
      }
    }

    // ── Small trailing plant (bottom shelf, right side — pothos vine) ──
    var plantX = T - 9, plantY = 21;
    // Tiny terracotta pot
    g.fillStyle = '#a06040';
    g.fillRect(plantX, plantY + 3, 4, 3);
    // Pot taper (slightly narrower at bottom)
    g.fillStyle = '#8a5030';
    g.fillRect(plantX + 0.3, plantY + 5, 3.4, 1);
    // Pot rim (wider lip)
    g.fillStyle = '#b07050';
    g.fillRect(plantX - 0.5, plantY + 3, 5, 1);
    g.fillStyle = 'rgba(200,150,100,0.1)'; // rim highlight
    g.fillRect(plantX - 0.5, plantY + 3, 5, 0.3);
    // Soil with tiny perlite specks
    g.fillStyle = '#3a2a1a';
    g.fillRect(plantX + 0.5, plantY + 3, 3, 1);
    g.fillStyle = 'rgba(220,210,190,0.08)'; // perlite
    g.fillRect(plantX + 1, plantY + 3.3, 0.5, 0.5);
    g.fillRect(plantX + 2.5, plantY + 3.2, 0.5, 0.5);

    // Main vine stems (3 trailing branches, more organic curves)
    // Branch 1 — trails right and up
    g.strokeStyle = '#3a6530'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(plantX + 2, plantY + 3);
    g.quadraticCurveTo(plantX + 5, plantY + 1, plantX + 3, plantY - 1);
    g.stroke();
    // Branch 2 — trails left and down (draping over shelf)
    g.beginPath(); g.moveTo(plantX + 1, plantY + 3);
    g.quadraticCurveTo(plantX - 1, plantY + 2, plantX - 3, plantY + 4);
    g.quadraticCurveTo(plantX - 4, plantY + 6, plantX - 3, plantY + 8);
    g.stroke();
    // Branch 3 — short upright sprig
    g.strokeStyle = '#4a7540'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(plantX + 1.5, plantY + 3);
    g.lineTo(plantX + 0.5, plantY + 1);
    g.stroke();

    // Heart-shaped leaves along vines (pothos style)
    var leaves = [
      [plantX + 3, plantY - 2, '#4a8040'],
      [plantX + 4.5, plantY, '#5a9050'],
      [plantX - 2, plantY + 3, '#4a8040'],
      [plantX - 3, plantY + 6, '#5a9050'],
      [plantX - 2.5, plantY + 8, '#4a7a3a'],
      [plantX + 0.5, plantY, '#5a9050'],
      [plantX + 2, plantY + 1, '#3a7030'],
    ];
    for (var li = 0; li < leaves.length; li++) {
      var lx = leaves[li][0], ly = leaves[li][1];
      g.fillStyle = leaves[li][2];
      // Tiny heart-ish leaf (2 overlapping circles)
      g.beginPath(); g.arc(lx, ly, 0.6, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(lx + 0.5, ly, 0.6, 0, Math.PI * 2); g.fill();
      // Leaf vein (tiny light line)
      g.strokeStyle = 'rgba(100,160,80,0.15)'; g.lineWidth = 0.2;
      g.beginPath(); g.moveTo(lx + 0.25, ly - 0.5); g.lineTo(lx + 0.25, ly + 0.5); g.stroke();
    }

    // Tiny flower bud (one small bloom on right branch)
    g.fillStyle = 'rgba(220,180,200,0.3)'; // pale pink
    g.beginPath(); g.arc(plantX + 4, plantY - 1, 0.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(240,220,100,0.2)'; // yellow center
    g.beginPath(); g.arc(plantX + 4, plantY - 1, 0.2, 0, Math.PI * 2); g.fill();

    // ── Bookend on top shelf (brass elephant — cast figurine, ~7×8px) ──
    // Positioned near right end of top shelf, sits ON the shelf plank
    var beX = T - 10, beY = 2;   // beY=2 so figure top clears 3px frame
    var brassBase = '#6e5a28', brassMid = '#8b7340', brassHi = '#b99a50', brassSheen = '#d4bc6e';

    // Base plate (flat slab under feet — anchor reads immediately)
    g.fillStyle = brassBase;
    g.fillRect(beX - 1, beY + 7, 7, 1.5);
    // Base plate top highlight (thin warm line — metal edge)
    g.fillStyle = 'rgba(212,188,110,0.35)';
    g.fillRect(beX - 1, beY + 7, 7, 0.5);

    // Legs (two stubby pillars — castings have thick legs)
    g.fillStyle = brassBase;
    g.fillRect(beX, beY + 5, 1.5, 2.5);   // left leg
    g.fillRect(beX + 3, beY + 5, 1.5, 2.5); // right leg
    // Leg highlight (left face catches light)
    g.fillStyle = 'rgba(212,188,110,0.22)';
    g.fillRect(beX, beY + 5, 0.5, 2.5);
    g.fillRect(beX + 3, beY + 5, 0.5, 2.5);

    // Body (barrel-shaped torso — widest part of elephant)
    g.fillStyle = brassMid;
    g.fillRect(beX, beY + 2, 5, 4);
    // Body underside shadow (cast by neck)
    g.fillStyle = brassBase;
    g.fillRect(beX, beY + 5, 5, 1);
    // Body side shadow (right flank in shade)
    g.fillStyle = 'rgba(50,38,15,0.25)';
    g.fillRect(beX + 4, beY + 2, 1, 4);
    // Body left highlight (warm raking light from left)
    g.fillStyle = 'rgba(212,188,110,0.28)';
    g.fillRect(beX, beY + 2, 1, 4);
    // Belly band (cast decorative ring — readable horizontal stripe)
    g.fillStyle = brassBase;
    g.fillRect(beX + 0.5, beY + 3.5, 4, 0.5);
    g.fillStyle = 'rgba(212,188,110,0.18)';
    g.fillRect(beX + 0.5, beY + 3.5, 4, 0.25);

    // Head (slightly narrower, slightly raised — distinct from body)
    g.fillStyle = brassMid;
    g.fillRect(beX + 1, beY, 4, 3);
    // Head top highlight (crown catches pendant lamp directly)
    g.fillStyle = brassSheen;
    g.fillRect(beX + 1.5, beY, 3, 0.5);
    // Head right shadow
    g.fillStyle = brassBase;
    g.fillRect(beX + 4, beY, 1, 3);

    // Ear (flat disc on left side — hallmark elephant silhouette, 3×3px)
    g.fillStyle = brassBase;
    g.fillRect(beX - 1, beY + 0.5, 2.5, 3);   // ear mass
    g.fillStyle = brassMid;
    g.fillRect(beX - 0.5, beY + 1, 1.5, 1.5); // ear face
    // Ear edge (the thin bright rim where ear lifts from head)
    g.fillStyle = 'rgba(212,188,110,0.30)';
    g.fillRect(beX - 1, beY + 0.5, 0.5, 3);

    // Trunk (curls down-right from below head — the unmistakable elephant read)
    g.fillStyle = brassMid;
    g.fillRect(beX + 3.5, beY + 3, 1, 2);   // trunk upper (downward)
    g.fillRect(beX + 4, beY + 5, 1, 1);     // trunk curl outward (tip)
    // Trunk shadow (underside darker)
    g.fillStyle = brassBase;
    g.fillRect(beX + 4.5, beY + 3, 0.5, 2);
    // Trunk tip highlight (rounded end catches light)
    g.fillStyle = 'rgba(212,188,110,0.25)';
    g.fillRect(beX + 4, beY + 4, 0.5, 0.5);

    // Tusk (tiny ivory stub under trunk — high contrast white reads at distance)
    g.fillStyle = 'rgba(240,230,200,0.70)';
    g.fillRect(beX + 3, beY + 3, 1, 0.5);

    // Overall specular sheen (diagonal warm glint across body — "polished brass" read)
    var brassGrd = g.createLinearGradient(beX, beY, beX + 5, beY + 8);
    brassGrd.addColorStop(0,    'rgba(220,195,120,0.22)');
    brassGrd.addColorStop(0.35, 'rgba(220,195,120,0.10)');
    brassGrd.addColorStop(1,    'rgba(220,195,120,0)');
    g.fillStyle = brassGrd;
    g.fillRect(beX - 1, beY, 8, 9);

    // ── The Grimoire — one special glowing book on middle shelf ──
    var grimX = 14, grimY = 12, grimW = 3, grimH = 6;
    // Glow aura (warm gold, radiates from the book)
    var auraGrd = g.createRadialGradient(grimX + 1.5, grimY + 3, 0, grimX + 1.5, grimY + 3, 8);
    auraGrd.addColorStop(0, 'rgba(245,180,60,0.12)');
    auraGrd.addColorStop(0.4, 'rgba(245,166,35,0.05)');
    auraGrd.addColorStop(1, 'rgba(245,166,35,0)');
    g.fillStyle = auraGrd;
    g.fillRect(grimX - 6, grimY - 4, 16, 14);

    // Book body (deep burgundy with gold shimmer)
    g.fillStyle = '#5a1a2a'; g.fillRect(grimX, grimY, grimW, grimH);
    // Gold spine embossing
    g.fillStyle = 'rgba(212,170,60,0.4)';
    g.fillRect(grimX, grimY + 1, 1, grimH - 2);
    // Gold title band
    g.fillStyle = 'rgba(245,200,80,0.35)';
    g.fillRect(grimX + 1, grimY + 2, grimW - 2, 1);
    // Gold symbol (tiny diamond)
    g.fillStyle = 'rgba(255,220,100,0.3)';
    g.fillRect(grimX + 1, grimY + 4, 1, 1);
    // Spine edge glow
    g.fillStyle = 'rgba(245,180,60,0.15)';
    g.fillRect(grimX - 1, grimY, 1, grimH);

    // Subtle dust motes near the book (2 tiny bright dots)
    g.fillStyle = 'rgba(255,220,130,0.15)';
    g.fillRect(grimX + 5, grimY - 1, 1, 1);
    g.fillRect(grimX - 2, grimY + 2, 1, 1);

    // Overall ambient warmth from the grimoire
    var glowGrad = g.createRadialGradient(T / 2, T / 2, 0, T / 2, T / 2, T * 0.45);
    glowGrad.addColorStop(0, 'rgba(245,166,35,0.03)');
    glowGrad.addColorStop(1, 'rgba(245,166,35,0)');
    g.fillStyle = glowGrad;
    g.fillRect(0, 0, T, T);

    // ── Aged patina / dust on top frame edge ──
    g.fillStyle = 'rgba(160,140,110,0.06)';
    g.fillRect(3, 3, T - 6, 2);

    // ── Floating dust motes in warm light ──
    var dustMotes = [
      [8, 7, 0.12], [22, 14, 0.08], [10, 22, 0.1],
      [26, 8, 0.06], [18, 24, 0.09], [7, 16, 0.07]
    ];
    for (var di = 0; di < dustMotes.length; di++) {
      g.fillStyle = 'rgba(255,230,160,' + dustMotes[di][2].toFixed(2) + ')';
      g.fillRect(dustMotes[di][0], dustMotes[di][1], 1, 1);
    }

    return c;
  }

  function renderChairFloor() {
    // Carpet base + classic café bentwood chair seen from above
    var c = renderCarpet();
    var g = c.getContext('2d');
    var cx = T / 2, cy = T / 2 + 1; // shift down slightly so backrest is visible

    // ── Chair legs (drawn first, behind seat) ──
    var legColor = '#3d2a1e', legLight = '#5a3d2e';
    // Four splayed legs with slight perspective (top legs shorter = farther)
    var legs = [
      { x: cx - 8, y: cy - 6, w: 2, h: 3 },  // back-left
      { x: cx + 6, y: cy - 6, w: 2, h: 3 },  // back-right
      { x: cx - 8, y: cy + 5, w: 2, h: 4 },  // front-left (longer)
      { x: cx + 6, y: cy + 5, w: 2, h: 4 },  // front-right (longer)
    ];
    for (var li = 0; li < legs.length; li++) {
      var leg = legs[li];
      g.fillStyle = legColor;
      g.fillRect(leg.x, leg.y, leg.w, leg.h);
      // Leg highlight (inner edge)
      g.fillStyle = legLight;
      g.fillRect(leg.x, leg.y, 1, leg.h);
    }
    // Cross-brace between legs (structural detail — fillRect, pixel-art safe)
    g.fillStyle = 'rgba(60,40,28,0.4)';
    g.fillRect(cx - 7, cy + 1, 14, 1);
    // Brace highlight (lighter top edge — wood catching overhead light)
    g.fillStyle = 'rgba(120,85,55,0.2)';
    g.fillRect(cx - 6, cy + 1, 12, 1);

    // ── Chair shadow on carpet (stronger for separation) ──
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath(); g.ellipse(cx + 1, cy + 2, 11, 9, 0, 0, Math.PI * 2); g.fill();

    // ── Backrest (curved bentwood arc, seen from above) ──
    // Outer curve — darker, thicker for mobile readability
    g.strokeStyle = '#3a2218'; g.lineWidth = 3;
    g.beginPath();
    g.ellipse(cx, cy - 5, 9, 4, 0, Math.PI + 0.3, -0.3);
    g.stroke();
    // Inner curve (lighter — shows bentwood thickness)
    g.strokeStyle = '#7a5840'; g.lineWidth = 1.4;
    g.beginPath();
    g.ellipse(cx, cy - 5, 7, 3, 0, Math.PI + 0.4, -0.4);
    g.stroke();
    // Backrest highlight (warm edge catching pendant light — boosted to 1px min)
    g.strokeStyle = 'rgba(210,170,120,0.3)'; g.lineWidth = 1.0;
    g.beginPath();
    g.ellipse(cx, cy - 5, 9, 4, 0, Math.PI + 0.5, -0.5);
    g.stroke();
    // Bentwood grain — two short parallel warm streaks along the arc body
    g.fillStyle = 'rgba(180,140,90,0.18)';
    g.fillRect(cx - 6, cy - 7, 4, 1);  // left grain streak
    g.fillRect(cx + 1, cy - 7, 4, 1);  // right grain streak
    g.fillStyle = 'rgba(40,20,10,0.15)';
    g.fillRect(cx - 5, cy - 6, 3, 1);  // shadow under left streak
    g.fillRect(cx + 2, cy - 6, 3, 1);  // shadow under right streak

    // ── Seat — round cushion (shifted to warm olive-brown, away from carpet's burgundy) ──
    // Seat base (dark rim — creates strong silhouette)
    g.fillStyle = '#3e2c1e';
    g.beginPath(); g.ellipse(cx, cy, 9, 7, 0, 0, Math.PI * 2); g.fill();
    // Cushion top — warm olive-tinted leather (distinct from carpet's red-brown)
    g.fillStyle = '#7a6248';
    g.beginPath(); g.ellipse(cx, cy, 8, 6, 0, 0, Math.PI * 2); g.fill();
    // Cushion padding gradient (puffed center — brighter to pop on phone)
    var cushGrad = g.createRadialGradient(cx - 1, cy - 1, 0, cx, cy, 7);
    cushGrad.addColorStop(0, 'rgba(170,140,100,0.35)');
    cushGrad.addColorStop(0.5, 'rgba(130,105,75,0.15)');
    cushGrad.addColorStop(1, 'rgba(30,20,10,0.2)');
    g.fillStyle = cushGrad;
    g.beginPath(); g.ellipse(cx, cy, 8, 6, 0, 0, Math.PI * 2); g.fill();

    // Cushion stitch lines — fillRect (pixel-art, mobile-safe, no sub-pixel strokes)
    g.fillStyle = 'rgba(50,35,20,0.28)';
    g.fillRect(cx - 5, cy, 10, 1);  // horizontal stitch
    g.fillRect(cx, cy - 4, 1, 8);   // vertical stitch
    // Center button (tufted cushion — slightly larger for phone)
    g.fillStyle = 'rgba(40,28,16,0.3)';
    g.beginPath(); g.arc(cx, cy, 1.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(200,170,120,0.2)';
    g.beginPath(); g.arc(cx - 0.5, cy - 0.5, 0.7, 0, Math.PI * 2); g.fill();

    // Seat edge rim — strong dark outline for mobile silhouette
    g.strokeStyle = 'rgba(20,12,6,0.3)'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(cx, cy, 8, 6, 0, 0, Math.PI * 2); g.stroke();
    // Seat highlight — warm rim catching overhead pendant glow (1px min, mobile-safe)
    g.strokeStyle = 'rgba(220,180,130,0.25)'; g.lineWidth = 1.0;
    g.beginPath(); g.ellipse(cx, cy, 7.5, 5.5, 0, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
    // Leather sheen — tiny specular dot upper-left (the warmest pixel in the seat)
    g.fillStyle = 'rgba(240,210,160,0.22)';
    g.beginPath(); g.arc(cx - 3, cy - 2, 1.2, 0, Math.PI * 2); g.fill();

    return c;
  }

  // Table variant counter — each call gets a different table scene
  var _tableVariant = 0;

  function renderTable() {
    // Carpet base + round bistro table with unique surface items per variant
    var c = renderCarpet();
    var g = c.getContext('2d');
    var cx = T / 2, cy = T / 2;
    var variant = _tableVariant++ % 7;

    // ── Table shadow (strong — must lift the table off carpet at phone scale) ──
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath(); g.ellipse(cx + 1.5, cy + 4, 13, 10, 0, 0, Math.PI * 2); g.fill();
    // Second softer penumbra
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.beginPath(); g.ellipse(cx + 1.5, cy + 4, 16, 13, 0, 0, Math.PI * 2); g.fill();

    // ── Pedestal base (ornate cast iron bistro style) ──
    // Three splayed feet (seen from above, radiating out)
    g.fillStyle = '#2a1c14';
    // Left foot
    g.beginPath();
    g.moveTo(cx - 1, cy + 1);
    g.quadraticCurveTo(cx - 4, cy + 2, cx - 6, cy + 4);
    g.lineTo(cx - 5, cy + 4);
    g.quadraticCurveTo(cx - 3, cy + 2, cx, cy + 2);
    g.fill();
    // Right foot
    g.beginPath();
    g.moveTo(cx + 1, cy + 1);
    g.quadraticCurveTo(cx + 4, cy + 2, cx + 6, cy + 4);
    g.lineTo(cx + 5, cy + 4);
    g.quadraticCurveTo(cx + 3, cy + 2, cx, cy + 2);
    g.fill();
    // Front foot (shorter, perspective)
    g.beginPath();
    g.moveTo(cx - 0.5, cy + 2);
    g.quadraticCurveTo(cx, cy + 4, cx + 0.5, cy + 5);
    g.lineTo(cx - 0.5, cy + 5);
    g.quadraticCurveTo(cx - 1, cy + 3.5, cx - 0.5, cy + 2);
    g.fill();
    // Foot pads (tiny flat ends)
    g.fillStyle = '#1e1410';
    g.fillRect(cx - 6.5, cy + 3.5, 2, 1);
    g.fillRect(cx + 5, cy + 3.5, 2, 1);
    g.fillRect(cx - 1, cy + 4.5, 2, 1);
    // Center base plate (where stem meets feet)
    g.fillStyle = '#2a1c14';
    g.beginPath(); g.ellipse(cx, cy + 2, 3, 2, 0, 0, Math.PI * 2); g.fill();
    // Base plate highlight (metallic sheen)
    g.fillStyle = 'rgba(100,70,50,0.15)';
    g.beginPath(); g.ellipse(cx - 0.5, cy + 1.5, 2, 1.2, 0, 0, Math.PI * 2); g.fill();
    // Decorative ring on base plate
    g.strokeStyle = 'rgba(80,55,35,0.2)'; g.lineWidth = 0.3;
    g.beginPath(); g.ellipse(cx, cy + 2, 2.5, 1.5, 0, 0, Math.PI * 2); g.stroke();
    // Stem (central column with turned detail)
    g.fillStyle = '#2a1c14';
    g.fillRect(cx - 1, cy - 2, 3, 5);
    // Stem highlight (left edge catches light)
    g.fillStyle = 'rgba(100,70,50,0.12)';
    g.fillRect(cx - 1, cy - 2, 1, 5);
    // Turned ring detail on stem (lathe marks)
    g.fillStyle = 'rgba(60,40,25,0.2)';
    g.fillRect(cx - 1.5, cy - 1, 4, 0.5);
    g.fillRect(cx - 1.5, cy + 1, 4, 0.5);

    // ── Table top — polished warm teak, clearly distinct from carpet ──
    // Outer rim (dark chocolate edge — bold silhouette at phone scale)
    g.fillStyle = '#3d2718';
    g.beginPath(); g.ellipse(cx, cy, 12, 10, 0, 0, Math.PI * 2); g.fill();
    // Main surface (warm amber-teak — noticeably brighter than carpet)
    g.fillStyle = '#8b5e3c';
    g.beginPath(); g.ellipse(cx, cy, 11, 9, 0, 0, Math.PI * 2); g.fill();
    // Warm center highlight (pendant lamp hot-spot)
    var topGlow = g.createRadialGradient(cx - 1, cy - 1, 0, cx, cy, 10);
    topGlow.addColorStop(0, 'rgba(255,210,140,0.22)');
    topGlow.addColorStop(0.5, 'rgba(255,190,100,0.06)');
    topGlow.addColorStop(1, 'rgba(255,190,100,0)');
    g.fillStyle = topGlow;
    g.beginPath(); g.ellipse(cx, cy, 11, 9, 0, 0, Math.PI * 2); g.fill();

    // Concentric growth rings (real wood has these)
    g.save();
    // Clip to table ellipse
    g.beginPath(); g.ellipse(cx, cy, 11, 9, 0, 0, Math.PI * 2); g.clip();

    g.strokeStyle = 'rgba(40,25,15,0.10)'; g.lineWidth = 0.5;
    for (var ri = 2; ri < 11; ri += 2) {
      g.beginPath();
      g.ellipse(cx + 1, cy + 1, ri, ri * 0.8, 0.2, 0, Math.PI * 2);
      g.stroke();
    }
    // Radial grain lines (emanating from center)
    g.strokeStyle = 'rgba(40,25,15,0.08)'; g.lineWidth = 0.4;
    for (var ai = 0; ai < 8; ai++) {
      var angle = ai * Math.PI / 4 + 0.3;
      g.beginPath();
      g.moveTo(cx + Math.cos(angle) * 2, cy + Math.sin(angle) * 2);
      g.lineTo(cx + Math.cos(angle) * 11, cy + Math.sin(angle) * 9);
      g.stroke();
    }

    // ── Surface items (different per variant) ──
    if (variant === 0) {
      // Cappuccino on saucer + cork coaster + sugar cube
      // Cork coaster (off to the side, slightly overlapping)
      g.fillStyle = '#a08058';
      g.beginPath(); g.ellipse(cx - 4, cy + 2, 2.8, 2.2, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(60,40,20,0.1)'; g.lineWidth = 0.3;
      g.beginPath(); g.ellipse(cx - 4, cy + 2, 2.8, 2.2, 0, 0, Math.PI * 2); g.stroke();
      // Coaster texture (tiny cork speckles)
      g.fillStyle = 'rgba(80,55,30,0.1)';
      g.fillRect(cx - 5, cy + 1.5, 1, 1);
      g.fillRect(cx - 3, cy + 2.5, 1, 1);

      // Saucer (bright white ceramic — must pop against warm teak)
      g.fillStyle = '#f5eedf';
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 3.8, 3, 0, 0, Math.PI * 2); g.fill();
      // Saucer inner ring
      g.strokeStyle = 'rgba(0,0,0,0.08)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 3, 2.4, 0, 0, Math.PI * 2); g.stroke();
      // Saucer rim highlight
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.6;
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 3.8, 3, 0, Math.PI * 1.1, Math.PI * 1.7); g.stroke();

      // Cup outer wall (large bright white — primary eye-catcher)
      g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 2.5, 2, 0, 0, Math.PI * 2); g.fill();
      // Cup rim highlight
      g.strokeStyle = 'rgba(220,210,195,0.5)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 2.5, 2, 0, Math.PI * 1.1, Math.PI * 1.8); g.stroke();
      // Cappuccino foam surface (warm cream)
      g.fillStyle = '#dfc8a0';
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 1.8, 1.45, 0, 0, Math.PI * 2); g.fill();
      // Foam highlight
      g.fillStyle = 'rgba(255,245,220,0.5)';
      g.beginPath(); g.ellipse(cx + 2.0, cy - 0.9, 0.9, 0.6, 0.3, 0, Math.PI * 2); g.fill();
      // Latte art heart (dark on foam)
      g.fillStyle = '#7a5530';
      g.beginPath(); g.ellipse(cx + 2.5, cy - 0.5, 1.1, 0.9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d8b880';
      // Heart shape bumps
      g.beginPath(); g.arc(cx + 2.1, cy - 0.75, 0.38, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + 2.9, cy - 0.75, 0.38, 0, Math.PI * 2); g.fill();
      g.beginPath();
      g.moveTo(cx + 1.7, cy - 0.5); g.lineTo(cx + 2.5, cy + 0.3); g.lineTo(cx + 3.3, cy - 0.5);
      g.fill();
      // Cup handle (bolder)
      g.strokeStyle = '#d4c0a0'; g.lineWidth = 1;
      g.beginPath(); g.arc(cx + 5.0, cy - 0.5, 1.1, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();

      // Sugar cube (tiny white block beside saucer)
      g.fillStyle = '#f5f0e8';
      g.fillRect(cx - 1, cy + 2, 1.5, 1.2);
      // Sugar cube shadow
      g.fillStyle = 'rgba(0,0,0,0.06)';
      g.fillRect(cx - 0.5, cy + 3, 1.5, 0.4);
      // Sugar cube highlight
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(cx - 1, cy + 2, 1.5, 0.4);
    } else if (variant === 1) {
      // Open book + reading glasses + bookmark
      // Book shadow (soft, beneath)
      g.fillStyle = 'rgba(0,0,0,0.06)';
      g.fillRect(cx - 4.5, cy - 2.5, 9, 6.5);
      // Left page (pure white — must pop hard against teak surface)
      g.fillStyle = '#fffbf0';
      g.fillRect(cx - 4, cy - 3, 4, 6);
      // Right page (brightest — overhead lamp hits it)
      g.fillStyle = '#ffffff';
      g.fillRect(cx, cy - 3, 4, 6);
      // Page edges (visible thickness on bottom)
      g.fillStyle = '#d8ccb0';
      g.fillRect(cx - 4, cy + 3, 8, 1);
      // Spine crease (bold dark center fold)
      g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(cx, cy - 3); g.lineTo(cx, cy + 3); g.stroke();
      // Spine shadow (pages curve into binding)
      g.fillStyle = 'rgba(0,0,0,0.04)';
      g.fillRect(cx - 0.8, cy - 3, 0.8, 6);
      g.fillRect(cx + 0.3, cy - 3, 0.5, 6);
      // Text lines (left page — denser)
      g.fillStyle = 'rgba(50,35,20,0.12)';
      for (var tl = 0; tl < 5; tl++) {
        var lw = 2.2 + ((tl * 7) % 3) * 0.3; // vary line length
        g.fillRect(cx - 3.5, cy - 2.2 + tl * 1.1, lw, 0.4);
      }
      // Text lines (right page)
      for (var tr = 0; tr < 5; tr++) {
        var rw = 2 + ((tr * 5 + 1) % 3) * 0.3;
        g.fillRect(cx + 0.8, cy - 2.2 + tr * 1.1, rw, 0.4);
      }
      // Paragraph indent on right page
      g.fillRect(cx + 1.5, cy - 0.5, 1.8, 0.4);

      // Ribbon bookmark (vivid red — strong pop of color on white page)
      g.fillStyle = '#cc2020';
      g.fillRect(cx + 2.5, cy - 3.5, 1.1, 4.5);
      // Bookmark end (hanging below book edge)
      g.fillStyle = '#aa1818';
      g.fillRect(cx + 2.3, cy + 0.8, 1.5, 1.8);
      // Forked tip
      g.fillStyle = '#8b5e3c'; // cut-out showing table wood behind
      g.fillRect(cx + 2.75, cy + 1.8, 0.5, 0.8);

      // Reading glasses (folded, resting beside book)
      g.save();
      g.translate(cx + 5, cy + 1);
      g.rotate(0.25);
      // Frame (thin wire)
      g.strokeStyle = '#8b7355'; g.lineWidth = 0.5;
      // Left lens
      g.beginPath(); g.ellipse(-1.5, 0, 1.2, 0.9, 0, 0, Math.PI * 2); g.stroke();
      // Right lens
      g.beginPath(); g.ellipse(1.5, 0, 1.2, 0.9, 0, 0, Math.PI * 2); g.stroke();
      // Bridge
      g.beginPath(); g.moveTo(-0.3, 0); g.lineTo(0.3, 0); g.stroke();
      // Temples (folded back)
      g.beginPath(); g.moveTo(-2.7, 0); g.lineTo(-3.5, -1); g.stroke();
      g.beginPath(); g.moveTo(2.7, 0); g.lineTo(3.5, -1); g.stroke();
      // Lens tint (very subtle)
      g.fillStyle = 'rgba(200,210,230,0.06)';
      g.beginPath(); g.ellipse(-1.5, 0, 1, 0.7, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(1.5, 0, 1, 0.7, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    } else if (variant === 2) {
      // Espresso cup + saucer + biscotti + folded napkin
      // Folded cloth napkin (slightly angled)
      g.save();
      g.translate(cx - 5, cy + 1);
      g.rotate(0.1);
      g.fillStyle = '#e8e0d0';
      g.fillRect(0, 0, 5, 4);
      // Napkin fold crease
      g.strokeStyle = 'rgba(0,0,0,0.06)'; g.lineWidth = 0.4;
      g.beginPath(); g.moveTo(0, 2); g.lineTo(5, 2); g.stroke();
      // Napkin shadow
      g.fillStyle = 'rgba(0,0,0,0.04)';
      g.fillRect(0, 3, 5, 1);
      // Embroidered corner detail (tiny colored stitch)
      g.fillStyle = 'rgba(140,80,60,0.2)';
      g.fillRect(3.5, 0.5, 1, 1);
      g.restore();
      // Saucer (brighter ceramic)
      g.fillStyle = '#ede2cc';
      g.beginPath(); g.ellipse(cx + 3, cy - 0.5, 3.2, 2.4, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(cx + 3, cy - 0.5, 3.2, 2.4, 0, 0, Math.PI * 2); g.stroke();
      // Saucer highlight
      g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 0.5;
      g.beginPath(); g.ellipse(cx + 3, cy - 0.5, 3.2, 2.4, 0, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
      // Espresso cup (demitasse — bright white body)
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(cx + 3, cy - 0.5, 1.8, 0, Math.PI * 2); g.fill();
      // Crema surface (rich golden-brown espresso)
      g.fillStyle = '#7a5430';
      g.beginPath(); g.arc(cx + 3, cy - 0.5, 1.3, 0, Math.PI * 2); g.fill();
      // Crema highlight (warm shimmer)
      g.fillStyle = 'rgba(200,150,80,0.45)';
      g.beginPath(); g.arc(cx + 2.5, cy - 0.9, 0.5, 0, Math.PI * 2); g.fill();
      // Cup handle (bolder)
      g.strokeStyle = '#c8b498'; g.lineWidth = 0.9;
      g.beginPath(); g.arc(cx + 4.8, cy - 0.5, 0.9, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
      // Small spoon on saucer
      g.strokeStyle = '#8b8b8b'; g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(cx + 1, cy + 1.5); g.lineTo(cx + 5, cy + 1.5); g.stroke();
      // Spoon bowl (tiny ellipse at end)
      g.fillStyle = '#999';
      g.beginPath(); g.ellipse(cx + 0.8, cy + 1.5, 0.6, 0.4, 0, 0, Math.PI * 2); g.fill();
      // Biscotti (angled, on saucer edge)
      g.save();
      g.translate(cx + 1, cy - 3);
      g.rotate(-0.4);
      g.fillStyle = '#c4a46a';
      g.fillRect(0, 0, 4, 1.5);
      // Biscotti texture (almond bits)
      g.fillStyle = '#a88a50';
      g.fillRect(0.5, 0.3, 0.6, 0.6);
      g.fillRect(2, 0.5, 0.5, 0.5);
      g.fillRect(3, 0.2, 0.5, 0.6);
      // Biscotti edge shadow
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.fillRect(0, 1.2, 4, 0.3);
      g.restore();
    } else if (variant === 3) {
      // Laptop (open, seen from above — screen + keyboard halves)
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.15);
      // Screen half (tilted back, foreshortened — thinner)
      g.fillStyle = '#2a2a2a';
      g.fillRect(-5, -5, 10, 4);
      // Screen bezel
      g.fillStyle = '#111';
      g.fillRect(-4.5, -4.5, 9, 3);
      // Screen glow (code editor — glowing dark blue, bright lines)
      g.fillStyle = '#0e0e22';
      g.fillRect(-4, -4, 8, 2.2);
      // Screen inner glow (backlight bleed, strong blue)
      var screenBacklight = g.createLinearGradient(-4, -4, 4, -2);
      screenBacklight.addColorStop(0, 'rgba(60,100,200,0.15)');
      screenBacklight.addColorStop(1, 'rgba(60,80,180,0.05)');
      g.fillStyle = screenBacklight;
      g.fillRect(-4, -4, 8, 2.2);
      // Code lines on screen (vivid — these are the pixel-level eye-catchers)
      g.fillStyle = 'rgba(80,220,110,0.85)';
      g.fillRect(-3.5, -3.85, 3.5, 0.55);
      g.fillStyle = 'rgba(120,170,255,0.80)';
      g.fillRect(-3.5, -3.1, 5.5, 0.55);
      g.fillStyle = 'rgba(255,200,70,0.75)';
      g.fillRect(-3.5, -2.35, 4.5, 0.55);
      // Screen light spill on table (bright blue-white)
      var screenGlow = g.createRadialGradient(0, -3, 0, 0, -3, 8);
      screenGlow.addColorStop(0, 'rgba(100,140,255,0.12)');
      screenGlow.addColorStop(1, 'rgba(100,140,255,0)');
      g.fillStyle = screenGlow;
      g.fillRect(-8, -8, 16, 10);
      // Keyboard half (closer, wider)
      g.fillStyle = '#3e3e3e';
      g.fillRect(-5, -0.5, 10, 5);
      // Keyboard surface (silver-grey)
      g.fillStyle = '#5a5a5a';
      g.fillRect(-4.5, 0, 9, 4);
      // Key rows (visible contrast dots)
      g.fillStyle = 'rgba(40,40,40,0.7)';
      for (var kr = 0; kr < 3; kr++) {
        for (var kc = 0; kc < 7; kc++) {
          g.fillRect(-3.8 + kc * 1.2, 0.5 + kr * 1.2, 0.9, 0.9);
        }
      }
      // Trackpad (lighter than keys)
      g.fillStyle = 'rgba(110,110,110,0.5)';
      g.fillRect(-1.8, 3.2, 3.6, 1.5);
      // Hinge shadow between screen and keyboard
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(-5, -0.8, 10, 0.6);
      g.restore();
      // Small coffee cup beside laptop
      g.fillStyle = '#d4c4a8';
      g.beginPath(); g.arc(cx + 8, cy + 3, 1.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3e2723';
      g.beginPath(); g.arc(cx + 8, cy + 3, 0.8, 0, Math.PI * 2); g.fill();
    } else if (variant === 4) {
      // Two cups + small flower vase (intimate conversation table)
      // Cup 1 — latte (left side, bright white body)
      g.fillStyle = '#ede3d0';
      g.beginPath(); g.ellipse(cx - 3, cy - 1, 2.3, 1.9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(cx - 3, cy - 1, 1.6, 0, Math.PI * 2); g.fill();
      // Latte foam (warm)
      g.fillStyle = '#c8a878';
      g.beginPath(); g.arc(cx - 3, cy - 1, 1.1, 0, Math.PI * 2); g.fill();
      // Rosetta highlight
      g.fillStyle = 'rgba(255,230,180,0.5)';
      g.beginPath(); g.ellipse(cx - 3.3, cy - 1.3, 0.5, 0.35, 0.3, 0, Math.PI * 2); g.fill();
      // Handle (bolder)
      g.strokeStyle = '#c4b098'; g.lineWidth = 0.9;
      g.beginPath(); g.arc(cx - 4.8, cy - 1, 0.9, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();

      // Cup 2 — black coffee (right side, bright white body)
      g.fillStyle = '#ede3d0';
      g.beginPath(); g.ellipse(cx + 3, cy + 1, 2.3, 1.9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(cx + 3, cy + 1, 1.6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1a100c';
      g.beginPath(); g.arc(cx + 3, cy + 1, 1.1, 0, Math.PI * 2); g.fill();
      // Surface reflection on black coffee (stronger)
      g.fillStyle = 'rgba(255,240,200,0.18)';
      g.beginPath(); g.arc(cx + 2.5, cy + 0.5, 0.5, 0, Math.PI * 2); g.fill();
      // Handle (bolder)
      g.strokeStyle = '#c4b098'; g.lineWidth = 0.9;
      g.beginPath(); g.arc(cx + 4.8, cy + 1, 0.9, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();

      // Small bud vase between cups (single bold flower — this is the icon of this table)
      // Vase (tinted glass with visible walls)
      g.fillStyle = 'rgba(160,200,180,0.25)';
      g.fillRect(cx - 0.6, cy - 2, 1.7, 3.2);
      g.strokeStyle = 'rgba(120,180,150,0.5)'; g.lineWidth = 0.5;
      g.strokeRect(cx - 0.6, cy - 2, 1.7, 3.2);
      // Water in vase
      g.fillStyle = 'rgba(160,210,220,0.2)';
      g.fillRect(cx - 0.5, cy, 1.5, 1);
      // Stem (bold green)
      g.strokeStyle = '#3a6a30'; g.lineWidth = 0.7;
      g.beginPath(); g.moveTo(cx + 0.25, cy - 2); g.lineTo(cx + 0.25, cy - 5); g.stroke();
      // Flower petals (vivid coral — strong hue pop)
      g.fillStyle = '#e04040';
      g.beginPath(); g.arc(cx + 0.25, cy - 5.2, 1.6, 0, Math.PI * 2); g.fill();
      // Petal detail (slightly lighter front petals)
      g.fillStyle = '#f06060';
      g.beginPath(); g.arc(cx + 0.25, cy - 5.8, 1.0, 0, Math.PI * 2); g.fill();
      // Flower center (bright yellow)
      g.fillStyle = '#f5d020';
      g.beginPath(); g.arc(cx + 0.25, cy - 5.3, 0.6, 0, Math.PI * 2); g.fill();
      // Flower center highlight
      g.fillStyle = '#ffe860';
      g.beginPath(); g.arc(cx + 0.05, cy - 5.45, 0.25, 0, Math.PI * 2); g.fill();
      // Leaf
      g.fillStyle = '#4a7a38';
      g.beginPath();
      g.moveTo(cx + 0.25, cy - 3.5);
      g.quadraticCurveTo(cx + 2.2, cy - 4.2, cx + 1.7, cy - 3);
      g.fill();

      // Sugar packet (torn, between cups)
      g.fillStyle = '#f0e8d8';
      g.save(); g.translate(cx + 1, cy + 3); g.rotate(0.3);
      g.fillRect(0, 0, 3, 1.2);
      g.fillStyle = 'rgba(100,60,40,0.15)';
      g.fillRect(0, 0.4, 3, 0.4);
      g.restore();
    } else if (variant === 5) {
      // Tea light candle (small votive in glass holder)
      // Candle glow on table surface (drawn first, behind everything)
      var candleGlow = g.createRadialGradient(cx, cy, 0, cx, cy, 7);
      candleGlow.addColorStop(0, 'rgba(255,180,60,0.1)');
      candleGlow.addColorStop(0.4, 'rgba(255,160,40,0.04)');
      candleGlow.addColorStop(1, 'rgba(255,140,20,0)');
      g.fillStyle = candleGlow;
      g.fillRect(cx - 7, cy - 7, 14, 14);

      // Glass holder (frosted with visible glass thickness)
      // Glass base (warm translucent amber)
      g.fillStyle = 'rgba(220,200,160,0.20)';
      g.beginPath(); g.arc(cx, cy, 3.2, 0, Math.PI * 2); g.fill();
      // Glass wall (tinted, visible)
      g.strokeStyle = 'rgba(200,215,230,0.40)'; g.lineWidth = 1.2;
      g.beginPath(); g.arc(cx, cy, 3.2, 0, Math.PI * 2); g.stroke();
      // Glass rim highlight (bright — glass catches overhead light hard)
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 0.6;
      g.beginPath(); g.arc(cx, cy, 3.2, Math.PI * 1.1, Math.PI * 1.85); g.stroke();
      // Inner glass shadow (thickness illusion)
      g.strokeStyle = 'rgba(150,170,200,0.15)'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(cx, cy, 2.7, 0, Math.PI * 2); g.stroke();

      // Wax (creamy solid fill — bright against dark table)
      g.fillStyle = '#f8f0de';
      g.beginPath(); g.arc(cx, cy, 2.3, 0, Math.PI * 2); g.fill();
      // Melted wax pool (slightly darker rim where wax meets glass)
      g.strokeStyle = 'rgba(220,200,170,0.3)'; g.lineWidth = 0.3;
      g.beginPath(); g.arc(cx, cy, 1.8, 0, Math.PI * 2); g.stroke();
      // Wax surface variation (slight uneven melting)
      g.fillStyle = 'rgba(230,215,190,0.4)';
      g.beginPath(); g.ellipse(cx + 0.5, cy + 0.3, 1, 0.7, 0.2, 0, Math.PI * 2); g.fill();

      // Wick (thin dark line above wax)
      g.strokeStyle = '#2a2015'; g.lineWidth = 0.4;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - 1.2); g.stroke();
      // Wick tip (charred black dot)
      g.fillStyle = '#111';
      g.beginPath(); g.arc(cx, cy - 1.2, 0.3, 0, Math.PI * 2); g.fill();

      // Flame (teardrop — vivid and bright at tiny scale)
      // Outer flame glow (wide amber halo)
      g.fillStyle = 'rgba(255,140,20,0.6)';
      g.beginPath();
      g.moveTo(cx, cy - 4); // tall tip
      g.quadraticCurveTo(cx + 1.5, cy - 2.2, cx + 1.0, cy - 1);
      g.quadraticCurveTo(cx, cy - 0.4, cx - 1.0, cy - 1);
      g.quadraticCurveTo(cx - 1.5, cy - 2.2, cx, cy - 4);
      g.fill();
      // Inner flame core (brilliant white-yellow)
      g.fillStyle = 'rgba(255,250,200,0.95)';
      g.beginPath();
      g.moveTo(cx, cy - 3.2);
      g.quadraticCurveTo(cx + 0.7, cy - 2.2, cx + 0.45, cy - 1.3);
      g.quadraticCurveTo(cx, cy - 0.9, cx - 0.45, cy - 1.3);
      g.quadraticCurveTo(cx - 0.7, cy - 2.2, cx, cy - 3.2);
      g.fill();
      // Flame glow halo
      var flameHalo = g.createRadialGradient(cx, cy - 2, 0, cx, cy - 2, 3);
      flameHalo.addColorStop(0, 'rgba(255,200,80,0.12)');
      flameHalo.addColorStop(1, 'rgba(255,200,80,0)');
      g.fillStyle = flameHalo;
      g.fillRect(cx - 3, cy - 5, 6, 6);

      // Small folded receipt (off to one side, someone already paid)
      g.save(); g.translate(cx + 4, cy + 2); g.rotate(-0.15);
      g.fillStyle = 'rgba(245,240,230,0.3)'; g.fillRect(0, 0, 3.5, 2);
      g.fillStyle = 'rgba(245,240,230,0.2)'; g.fillRect(0, 0, 3.5, 1); // folded half (lighter)
      // Printed text lines
      g.fillStyle = 'rgba(80,60,50,0.12)';
      g.fillRect(0.3, 0.4, 2.5, 0.3);
      g.fillRect(0.3, 1, 2, 0.3);
      g.fillRect(0.3, 1.4, 1.5, 0.3);
      g.restore();

      // Water ring stain (ghost of a previous cup)
      g.strokeStyle = 'rgba(180,160,130,0.05)'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(cx - 4, cy + 2, 2, 0, Math.PI * 2); g.stroke();
    } else {
      // ── Variant 6: Teapot + two small teacups (afternoon tea scene) ──
      // Teapot positioned slightly left-of-center, cups flanking it

      // Teapot body shadow (cast on table — soft ellipse beneath)
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.beginPath(); g.ellipse(cx - 1.5, cy + 2.2, 4.5, 2, 0, 0, Math.PI * 2); g.fill();

      // Teapot body base colour (celadon ceramic — muted sage-green glaze)
      var tpX = cx - 1.5, tpY = cy - 0.5;
      g.fillStyle = '#7a9e88';
      g.beginPath(); g.ellipse(tpX, tpY, 4.2, 3.4, 0, 0, Math.PI * 2); g.fill();

      // Ceramic glaze gradation — lit from upper-left (pendant lamp)
      var tpGlaze = g.createRadialGradient(tpX - 1.2, tpY - 1.5, 0.3, tpX, tpY, 4.5);
      tpGlaze.addColorStop(0,   'rgba(200,235,215,0.55)'); // bright highlight
      tpGlaze.addColorStop(0.35,'rgba(160,210,185,0.20)'); // mid glaze
      tpGlaze.addColorStop(0.7, 'rgba(90,130,105,0.10)');  // shadow zone
      tpGlaze.addColorStop(1,   'rgba(50,80,65,0.25)');    // dark base rim
      g.fillStyle = tpGlaze;
      g.beginPath(); g.ellipse(tpX, tpY, 4.2, 3.4, 0, 0, Math.PI * 2); g.fill();

      // Teapot body outline (thin dark stroke for crispness)
      g.strokeStyle = 'rgba(30,55,40,0.40)'; g.lineWidth = 0.6;
      g.beginPath(); g.ellipse(tpX, tpY, 4.2, 3.4, 0, 0, Math.PI * 2); g.stroke();

      // ── Spout (curves forward-right from body) ──
      g.fillStyle = '#7a9e88';
      g.beginPath();
      g.moveTo(tpX + 3.6, tpY - 0.8);  // base of spout at body edge
      g.quadraticCurveTo(tpX + 5.8, tpY - 1.8, tpX + 7.0, tpY - 3.2); // curve outward
      g.quadraticCurveTo(tpX + 7.2, tpY - 3.5, tpX + 6.8, tpY - 3.0); // tip curve back
      g.quadraticCurveTo(tpX + 5.5, tpY - 1.3, tpX + 3.2, tpY + 0.3); // inner curve
      g.closePath(); g.fill();
      // Spout glaze highlight
      g.strokeStyle = 'rgba(200,235,215,0.45)'; g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(tpX + 3.8, tpY - 1.0);
      g.quadraticCurveTo(tpX + 5.6, tpY - 1.9, tpX + 6.7, tpY - 3.1);
      g.stroke();
      // Spout outline
      g.strokeStyle = 'rgba(30,55,40,0.35)'; g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(tpX + 3.6, tpY - 0.8);
      g.quadraticCurveTo(tpX + 5.8, tpY - 1.8, tpX + 7.0, tpY - 3.2);
      g.stroke();

      // ── Handle (loop on left side — kept inside table ellipse) ──
      g.strokeStyle = '#6a8e78'; g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(tpX - 3.6, tpY - 1.2);
      g.bezierCurveTo(tpX - 5.8, tpY - 2.0, tpX - 5.8, tpY + 2.0, tpX - 3.6, tpY + 1.2);
      g.stroke();
      // Handle highlight
      g.strokeStyle = 'rgba(190,225,205,0.5)'; g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(tpX - 3.8, tpY - 1.0);
      g.bezierCurveTo(tpX - 5.5, tpY - 1.6, tpX - 5.5, tpY + 1.2, tpX - 3.8, tpY + 1.0);
      g.stroke();

      // ── Lid (slightly domed, seated in shoulder of pot) ──
      // Lid base (slightly darker than body — recessed)
      g.fillStyle = '#5e8470';
      g.beginPath(); g.ellipse(tpX, tpY - 3.1, 2.4, 0.9, 0, 0, Math.PI * 2); g.fill();
      // Lid dome (main colour)
      g.fillStyle = '#7a9e88';
      g.beginPath(); g.ellipse(tpX, tpY - 3.6, 2.2, 1.0, 0, 0, Math.PI * 2); g.fill();
      // Lid glaze
      var lidGlaze = g.createRadialGradient(tpX - 0.6, tpY - 4.2, 0.1, tpX, tpY - 3.6, 2.4);
      lidGlaze.addColorStop(0,   'rgba(220,245,230,0.50)');
      lidGlaze.addColorStop(0.6, 'rgba(160,210,185,0.12)');
      lidGlaze.addColorStop(1,   'rgba(50,80,65,0.10)');
      g.fillStyle = lidGlaze;
      g.beginPath(); g.ellipse(tpX, tpY - 3.6, 2.2, 1.0, 0, 0, Math.PI * 2); g.fill();
      // Lid outline
      g.strokeStyle = 'rgba(30,55,40,0.35)'; g.lineWidth = 0.5;
      g.beginPath(); g.ellipse(tpX, tpY - 3.6, 2.2, 1.0, 0, 0, Math.PI * 2); g.stroke();
      // ── Lid knob (small ceramic finial) ──
      // Knob shadow
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.beginPath(); g.ellipse(tpX + 0.2, tpY - 4.9, 0.7, 0.35, 0, 0, Math.PI * 2); g.fill();
      // Knob body
      g.fillStyle = '#7a9e88';
      g.beginPath(); g.arc(tpX, tpY - 5.0, 0.75, 0, Math.PI * 2); g.fill();
      // Knob glaze highlight
      g.fillStyle = 'rgba(220,245,230,0.65)';
      g.beginPath(); g.arc(tpX - 0.25, tpY - 5.3, 0.32, 0, Math.PI * 2); g.fill();
      // Knob outline
      g.strokeStyle = 'rgba(30,55,40,0.30)'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(tpX, tpY - 5.0, 0.75, 0, Math.PI * 2); g.stroke();

      // ── Steam wisps from spout tip ──
      g.strokeStyle = 'rgba(220,235,230,0.28)'; g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(tpX + 7.0, tpY - 3.3);
      g.quadraticCurveTo(tpX + 7.6, tpY - 4.5, tpX + 7.0, tpY - 5.6);
      g.stroke();
      g.strokeStyle = 'rgba(220,235,230,0.18)'; g.lineWidth = 0.4;
      g.beginPath();
      g.moveTo(tpX + 6.5, tpY - 3.2);
      g.quadraticCurveTo(tpX + 5.8, tpY - 4.4, tpX + 6.3, tpY - 5.4);
      g.stroke();

      // ── Teacup 1 (right of pot, small — already poured, has tea) ──
      var tc1x = cx + 5.5, tc1y = cy + 1.5;
      // Saucer
      g.fillStyle = '#e8dfc8';
      g.beginPath(); g.ellipse(tc1x, tc1y + 1.2, 2.2, 1.5, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.08)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(tc1x, tc1y + 1.2, 2.2, 1.5, 0, 0, Math.PI * 2); g.stroke();
      // Saucer highlight
      g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(tc1x, tc1y + 1.2, 2.2, 1.5, 0, Math.PI * 1.1, Math.PI * 1.75); g.stroke();
      // Cup body (bright white ceramic)
      g.fillStyle = '#f5f0e8';
      g.beginPath(); g.arc(tc1x, tc1y, 1.5, 0, Math.PI * 2); g.fill();
      // Tea surface (amber-brown — freshly poured)
      g.fillStyle = '#c4813a';
      g.beginPath(); g.arc(tc1x, tc1y, 1.05, 0, Math.PI * 2); g.fill();
      // Tea surface reflection (small bright crescent)
      g.fillStyle = 'rgba(255,220,160,0.40)';
      g.beginPath(); g.arc(tc1x - 0.4, tc1y - 0.4, 0.38, 0, Math.PI * 2); g.fill();
      // Cup outline
      g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(tc1x, tc1y, 1.5, 0, Math.PI * 2); g.stroke();
      // Cup handle
      g.strokeStyle = '#cfc4aa'; g.lineWidth = 0.8;
      g.beginPath(); g.arc(tc1x + 2.2, tc1y, 0.75, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();

      // ── Teacup 2 (below-left of pot — empty, waiting) ──
      var tc2x = cx - 5, tc2y = cy + 3;
      // Saucer
      g.fillStyle = '#e8dfc8';
      g.beginPath(); g.ellipse(tc2x, tc2y + 1.2, 2.2, 1.5, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.08)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(tc2x, tc2y + 1.2, 2.2, 1.5, 0, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(tc2x, tc2y + 1.2, 2.2, 1.5, 0, Math.PI * 1.1, Math.PI * 1.75); g.stroke();
      // Cup body
      g.fillStyle = '#f5f0e8';
      g.beginPath(); g.arc(tc2x, tc2y, 1.5, 0, Math.PI * 2); g.fill();
      // Empty cup interior (very pale cream wash)
      g.fillStyle = '#e8dcc8';
      g.beginPath(); g.arc(tc2x, tc2y, 1.05, 0, Math.PI * 2); g.fill();
      // Cup interior highlight
      g.fillStyle = 'rgba(255,250,240,0.35)';
      g.beginPath(); g.arc(tc2x - 0.3, tc2y - 0.3, 0.45, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(tc2x, tc2y, 1.5, 0, Math.PI * 2); g.stroke();
      // Handle (facing left)
      g.strokeStyle = '#cfc4aa'; g.lineWidth = 0.8;
      g.beginPath(); g.arc(tc2x - 2.2, tc2y, 0.75, Math.PI * 0.5, -Math.PI * 0.5); g.stroke();

      // ── Tiny honey pot / sugar dish between cups (small accent) ──
      var spX = cx + 3.0, spY = cy + 3.8;
      g.fillStyle = '#d4a840';
      g.beginPath(); g.ellipse(spX, spY, 1.1, 0.8, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,230,140,0.50)';
      g.beginPath(); g.ellipse(spX - 0.3, spY - 0.25, 0.5, 0.35, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(140,80,20,0.30)'; g.lineWidth = 0.4;
      g.beginPath(); g.ellipse(spX, spY, 1.1, 0.8, 0, 0, Math.PI * 2); g.stroke();
    }

    g.restore(); // un-clip

    // ── Per-variant signature spotlight (makes key object pop at mobile scale) ──
    // Each table gets a focused bright point on its most identifiable object
    var spotX = cx, spotY = cy, spotColor = '255,220,160', spotA = 0.18, spotR = 5;
    if (variant === 0) {
      // Cappuccino: halo over white cup
      spotX = cx + 2.5; spotY = cy - 0.5; spotColor = '255,252,242'; spotA = 0.28; spotR = 4;
    } else if (variant === 1) {
      // Open book: bright page glow
      spotX = cx; spotY = cy; spotColor = '255,248,225'; spotA = 0.25; spotR = 6;
    } else if (variant === 2) {
      // Espresso: cup halo
      spotX = cx + 3; spotY = cy - 0.5; spotColor = '255,242,222'; spotA = 0.22; spotR = 4;
    } else if (variant === 3) {
      // Laptop: strong blue-white screen glow
      spotX = cx; spotY = cy - 3; spotColor = '120,170,255'; spotA = 0.30; spotR = 6;
    } else if (variant === 4) {
      // Two cups + vase: warm red-orange flower halo
      spotX = cx + 0.25; spotY = cy - 5.3; spotColor = '255,100,100'; spotA = 0.25; spotR = 4;
    } else if (variant === 5) {
      // Candle: strong warm amber flame halo
      spotX = cx; spotY = cy - 2; spotColor = '255,190,60'; spotA = 0.38; spotR = 6;
    } else {
      // Teapot: warm celadon glaze highlight on pot body
      spotX = cx - 1.5; spotY = cy - 1.5; spotColor = '200,235,215'; spotA = 0.22; spotR = 5;
    }
    var itemSpot = g.createRadialGradient(spotX, spotY, 0, spotX, spotY, spotR);
    itemSpot.addColorStop(0, 'rgba(' + spotColor + ',' + spotA.toFixed(2) + ')');
    itemSpot.addColorStop(0.5, 'rgba(' + spotColor + ',' + (spotA * 0.3).toFixed(3) + ')');
    itemSpot.addColorStop(1, 'rgba(' + spotColor + ',0)');
    g.fillStyle = itemSpot;
    g.beginPath(); g.ellipse(spotX, spotY, spotR, spotR, 0, 0, Math.PI * 2); g.fill();

    // ── Polished highlight — warm pendant lamp gleam from above ──
    var tableShine = g.createRadialGradient(cx - 2, cy - 2, 0, cx, cy, 11);
    tableShine.addColorStop(0, 'rgba(255,225,160,0.30)');
    tableShine.addColorStop(0.35, 'rgba(255,210,130,0.10)');
    tableShine.addColorStop(1, 'rgba(255,190,100,0)');
    g.fillStyle = tableShine;
    g.beginPath(); g.ellipse(cx, cy, 11, 9, 0, 0, Math.PI * 2); g.fill();

    // ── Rim bevel — polished lacquer edge, 3-D thickness at phone scale ──
    // Outer dark border (heaviest stroke — hard silhouette separating table from carpet)
    g.strokeStyle = 'rgba(15,7,2,0.72)'; g.lineWidth = 2.0;
    g.beginPath(); g.ellipse(cx, cy, 12, 10, 0, 0, Math.PI * 2); g.stroke();
    // Darker edge band (annular fill — sells rounded-over thickness of the slab)
    g.strokeStyle = 'rgba(30,15,6,0.38)'; g.lineWidth = 1.2;
    g.beginPath(); g.ellipse(cx, cy, 11.5, 9.5, 0, 0, Math.PI * 2); g.stroke();
    // Mid veneer band (warm exposed wood grain on the rim face)
    g.strokeStyle = 'rgba(110,65,30,0.28)'; g.lineWidth = 0.7;
    g.beginPath(); g.ellipse(cx, cy, 11.1, 9.1, 0, 0, Math.PI * 2); g.stroke();
    // Inner occlusion shadow (where rim curves under the surface — darkest zone)
    g.strokeStyle = 'rgba(15,7,2,0.22)'; g.lineWidth = 0.6;
    g.beginPath(); g.ellipse(cx, cy, 10.4, 8.4, 0, 0, Math.PI * 2); g.stroke();
    // Bevel top-arc highlight — broad warm gloss (pendant lamp hits the rounded rim)
    g.strokeStyle = 'rgba(255,218,150,0.55)'; g.lineWidth = 1.3;
    g.beginPath(); g.ellipse(cx, cy, 11.5, 9.5, 0, Math.PI * 1.02, Math.PI * 1.72); g.stroke();
    // Bevel tight specular — narrow bright arc (lacquer hot-catch, pure white-gold)
    g.strokeStyle = 'rgba(255,248,220,0.70)'; g.lineWidth = 0.5;
    g.beginPath(); g.ellipse(cx, cy, 11.6, 9.6, 0, Math.PI * 1.12, Math.PI * 1.52); g.stroke();
    // Bevel shadow arc — lower-right underside (depth / table hangs in air)
    g.strokeStyle = 'rgba(8,3,1,0.38)'; g.lineWidth = 1.0;
    g.beginPath(); g.ellipse(cx, cy, 11.5, 9.5, 0, Math.PI * 0.02, Math.PI * 0.72); g.stroke();
    // Lacquer specular dot — pendant lamp point reflection on glossy surface
    // Small ellipse off-center upper-left; bright core fading to transparent
    var specGrad = g.createRadialGradient(cx - 3.5, cy - 2.8, 0, cx - 3.5, cy - 2.8, 2.8);
    specGrad.addColorStop(0,    'rgba(255,252,238,0.72)');
    specGrad.addColorStop(0.35, 'rgba(255,240,190,0.28)');
    specGrad.addColorStop(0.7,  'rgba(255,230,160,0.08)');
    specGrad.addColorStop(1,    'rgba(255,230,160,0)');
    g.fillStyle = specGrad;
    g.beginPath(); g.ellipse(cx - 3.5, cy - 2.8, 2.8, 1.8, -0.4, 0, Math.PI * 2); g.fill();

    return c;
  }

  function renderDoor() {
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Exterior ground (player stands here — cool stone outside the cafe) ──
    // This contrasts with the warm interior, framing the door as a threshold
    g.fillStyle = '#b0a898'; g.fillRect(0, 0, T, T);
    // Stone grout lines (subtle grid)
    g.strokeStyle = 'rgba(140,130,118,0.6)'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(0, T / 2); g.lineTo(T, T / 2); g.stroke();
    g.beginPath(); g.moveTo(T / 2, 0); g.lineTo(T / 2, T); g.stroke();

    // ── Door frame (chunky, dark — strong silhouette at phone distance) ──
    var frameL = 3, frameR = 3, frameT = 0;
    g.fillStyle = '#1c1008';
    // Left jamb
    g.fillRect(0, frameT, frameL, T);
    // Right jamb
    g.fillRect(T - frameR, frameT, frameR, T);
    // Top lintel
    g.fillRect(0, 0, T, frameT + 2);
    // Frame inner bevel (warm wood edge catches light)
    g.fillStyle = '#4a2e14';
    g.fillRect(frameL, frameT, 1, T);
    g.fillRect(T - frameR - 1, frameT, 1, T);

    // ── Door panel (rich warm mahogany — saturated and bright vs dark frame) ──
    var doorL = frameL + 1, doorTop = frameT + 1, doorW = T - frameL - frameR - 2, doorH = T - doorTop - 5;
    g.fillStyle = '#7a3e1e'; g.fillRect(doorL, doorTop, doorW, doorH);

    // Vertical wood grain lines
    g.strokeStyle = 'rgba(60,30,10,0.35)'; g.lineWidth = 0.7;
    for (var gi = 0; gi < 4; gi++) {
      var gx = doorL + 3 + gi * 5.5;
      g.beginPath();
      g.moveTo(gx, doorTop + 1);
      g.quadraticCurveTo(gx + (gi % 2 ? 0.8 : -0.8), doorTop + doorH * 0.5, gx, doorTop + doorH - 1);
      g.stroke();
    }
    // Door face highlight (left edge catches ambient light)
    g.fillStyle = 'rgba(255,200,140,0.10)';
    g.fillRect(doorL, doorTop, 2, doorH);

    // ── Upper recessed panel ──
    var panelM = 3;
    var upPanY = doorTop + 2, upPanH = 9;
    g.fillStyle = '#5e2e12'; // darker recess
    g.fillRect(doorL + panelM, upPanY, doorW - panelM * 2, upPanH);
    // Bevel: dark top/left, bright bottom/right
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(doorL + panelM, upPanY, doorW - panelM * 2, 1);
    g.fillRect(doorL + panelM, upPanY, 1, upPanH);
    g.fillStyle = 'rgba(255,180,80,0.18)';
    g.fillRect(doorL + panelM, upPanY + upPanH - 1, doorW - panelM * 2, 1);
    g.fillRect(doorL + panelM + doorW - panelM * 2 - 1, upPanY, 1, upPanH);

    // ── Lower recessed panel ──
    var loPanY = doorTop + 14, loPanH = doorH - 14 - 3;
    g.fillStyle = '#5e2e12';
    g.fillRect(doorL + panelM, loPanY, doorW - panelM * 2, loPanH);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(doorL + panelM, loPanY, doorW - panelM * 2, 1);
    g.fillRect(doorL + panelM, loPanY, 1, loPanH);
    g.fillStyle = 'rgba(255,180,80,0.18)';
    g.fillRect(doorL + panelM, loPanY + loPanH - 1, doorW - panelM * 2, 1);
    g.fillRect(doorL + panelM + doorW - panelM * 2 - 1, loPanY, 1, loPanH);

    // ── Brass door handle — bold, unmissable at phone scale ──
    var hx = doorL + doorW - 6, hy = Math.floor(doorTop + doorH * 0.48);
    // Drop shadow for depth
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.arc(hx + 1, hy + 1, 3, 0, Math.PI * 2); g.fill();
    // Knob body — bright brass
    g.fillStyle = '#c8920e';
    g.beginPath(); g.arc(hx, hy, 3, 0, Math.PI * 2); g.fill();
    // Knob mid-tone ring
    g.fillStyle = '#e8b020';
    g.beginPath(); g.arc(hx, hy, 2, 0, Math.PI * 2); g.fill();
    // Specular highlight — the "glint"
    g.fillStyle = '#fff7d0';
    g.beginPath(); g.arc(hx - 1, hy - 1, 1, 0, Math.PI * 2); g.fill();
    // Knob plate backing (escutcheon)
    g.strokeStyle = '#9a7010'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(hx, hy, 3.5, 0, Math.PI * 2); g.stroke();

    // ── Keyhole ──
    g.fillStyle = '#0e0806';
    g.beginPath(); g.arc(hx, hy + 4, 1, 0, Math.PI * 2); g.fill();
    g.fillRect(hx - 0.5, hy + 4, 1, 2.5);

    // ── Threshold warm light band — the HERO element ──
    // Inside the cafe is warm; light bleeds under the door onto the stone outside
    // This is what the player's eye lands on. Make it read.
    var threshY = doorTop + doorH; // bottom of the door panel
    // Amber glow strip directly under the door — solid, readable
    g.fillStyle = '#e8a030';
    g.fillRect(doorL, threshY, doorW, 2);
    // Glow falloff onto the stone floor — fan outward
    var threshGrd = g.createLinearGradient(doorL, threshY + 2, doorL, T);
    threshGrd.addColorStop(0, 'rgba(240,160,40,0.65)');
    threshGrd.addColorStop(0.5, 'rgba(240,160,40,0.25)');
    threshGrd.addColorStop(1, 'rgba(240,160,40,0)');
    g.fillStyle = threshGrd;
    g.fillRect(doorL - 1, threshY + 2, doorW + 2, T - threshY - 2);

    // ── Welcome mat — high contrast on the warm-lit stone ──
    var matY = threshY + 2, matH = T - matY - 1;
    g.fillStyle = '#2e200e'; // dark coir against the warm glow
    g.fillRect(doorL, matY, doorW, matH);
    // Mat border stripe (visible at phone scale)
    g.fillStyle = '#c8a050';
    g.fillRect(doorL, matY, doorW, 1);
    g.fillRect(doorL, matY + matH - 1, doorW, 1);
    // Weave texture
    g.strokeStyle = 'rgba(100,75,40,0.5)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(doorL + 1, matY + 2); g.lineTo(doorL + doorW - 1, matY + 2); g.stroke();
    if (matH > 4) {
      g.beginPath(); g.moveTo(doorL + 1, matY + 3); g.lineTo(doorL + doorW - 1, matY + 3); g.stroke();
    }

    // ── Frame shadow edges (reinforce depth) ──
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(0, 0, frameL, T);          // left jamb shadow
    g.fillRect(T - frameR, 0, frameR, T); // right jamb shadow

    return c;
  }

  function renderNewsWall() {
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Cork board background — warm gradient (lit by fairy lights above) ──
    var corkGrd = g.createLinearGradient(0, 0, 0, T);
    corkGrd.addColorStop(0,   '#a07858'); // warm amber top — bulb warmth
    corkGrd.addColorStop(0.3, '#8b6b4a'); // mid cork
    corkGrd.addColorStop(1,   '#6e5238'); // darker, cooler bottom
    g.fillStyle = corkGrd; g.fillRect(0, 0, T, T);
    // Cork texture — slightly denser speckle pattern for legibility
    var speckles = [
      [2,3,'#b08860'],[6,1,'#7a5c3a'],[10,5,'#ae8662'],[14,2,'#7d5f3e'],
      [3,8,'#b89070'],[8,11,'#7a5c3a'],[12,9,'#9f7c58'],[15,14,'#b08860'],
      [1,15,'#7d5f3e'],[5,18,'#ae8662'],[9,22,'#9f7c58'],[13,20,'#b89070'],
      [4,26,'#7a5c3a'],[11,25,'#b08860'],[7,29,'#9f7c58'],[14,28,'#7d5f3e'],
      [2,13,'#ae8662'],[10,17,'#b89070'],[6,24,'#7d5f3e'],[15,7,'#b08860'],
      [19,4,'#9f7c58'],[24,9,'#b08860'],[28,6,'#7a5c3a'],[22,16,'#ae8662'],
      [26,19,'#b89070'],[29,24,'#9f7c58'],[17,27,'#7d5f3e'],[25,29,'#b08860']
    ];
    for (var si = 0; si < speckles.length; si++) {
      g.fillStyle = speckles[si][2];
      g.fillRect(speckles[si][0], speckles[si][1], 1, 1);
    }

    // ── Solid wood frame border — thicker for mobile legibility ──
    g.fillStyle = '#3d2515';
    g.fillRect(0, 0, T, 2);       // top rail
    g.fillRect(0, T - 2, T, 2);   // bottom rail
    g.fillRect(0, 0, 2, T);       // left stile
    g.fillRect(T - 2, 0, 2, T);   // right stile
    // Inner frame highlight (warm light catching the lip)
    g.fillStyle = 'rgba(180,130,70,0.25)';
    g.fillRect(2, 2, T - 4, 0.5);
    g.fillRect(2, 2, 0.5, T - 4);
    // Inner frame shadow (bottom/right edges recede)
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(2, T - 2.5, T - 4, 0.5);
    g.fillRect(T - 2.5, 2, 0.5, T - 4);

    // ── Pinned notes and clippings ──

    // Note 1 — aged yellow sticky note (top-left, slightly tilted)
    g.save();
    g.translate(4, 4);
    g.rotate(-0.08);
    // Drop shadow (offset down-right, bold enough for mobile)
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(1.5, 1.5, 9, 8);
    g.fillStyle = '#e8d8a0'; g.fillRect(0, 0, 9, 8);
    // Fold shadow at bottom
    g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, 6, 9, 2);
    // Tiny text lines
    g.fillStyle = '#8b7355';
    g.fillRect(1, 2, 6, 0.7);
    g.fillRect(1, 4, 5, 0.7);
    g.fillRect(1, 5.5, 4, 0.7);
    // Pin (warm red)
    g.fillStyle = '#c0392b';
    g.beginPath(); g.arc(4.5, 1, 1.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e74c3c';
    g.beginPath(); g.arc(4.2, 0.7, 0.5, 0, Math.PI * 2); g.fill();
    g.restore();

    // Note 2 — small polaroid-style photo (top-right)
    g.save();
    g.translate(17, 3);
    g.rotate(0.12);
    // Drop shadow
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(1.5, 1.5, 11, 12);
    // White border
    g.fillStyle = '#f0ead6'; g.fillRect(0, 0, 11, 12);
    g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(0, 10, 11, 2);
    // Photo area — warm sepia scene
    g.fillStyle = '#6d5a40'; g.fillRect(1, 1, 9, 8);
    // Blurry warm shapes inside photo
    g.fillStyle = '#8b7355'; g.fillRect(2, 3, 3, 4);
    g.fillStyle = '#7a6245'; g.fillRect(6, 2, 3, 5);
    g.fillStyle = '#9e8b6e'; g.fillRect(3, 5, 4, 2);
    // Pin
    g.fillStyle = '#2c7a2c';
    g.beginPath(); g.arc(5.5, 1, 1.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3a9a3a';
    g.beginPath(); g.arc(5.2, 0.7, 0.5, 0, Math.PI * 2); g.fill();
    g.restore();

    // Note 3 — torn newspaper clipping (middle-left)
    g.save();
    g.translate(2, 15);
    g.rotate(0.05);
    // Drop shadow
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(1.5, 1.5, 12, 7);
    g.fillStyle = '#d6ccb8'; g.fillRect(0, 0, 12, 7);
    // Torn edge effect (right side)
    g.fillStyle = '#8b6b4a';
    g.fillRect(11, 0, 1, 1); g.fillRect(12, 2, 1, 1);
    g.fillRect(11, 4, 1, 1); g.fillRect(12, 6, 1, 1);
    // Headline text
    g.fillStyle = '#3d3125';
    g.fillRect(1, 1, 8, 1);
    // Body text lines
    g.fillStyle = '#8b7e6e';
    g.fillRect(1, 3, 9, 0.5);
    g.fillRect(1, 4.2, 7, 0.5);
    g.fillRect(1, 5.4, 8, 0.5);
    // Pin
    g.fillStyle = '#c0a030';
    g.beginPath(); g.arc(6, 0.5, 1, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d4b440';
    g.beginPath(); g.arc(5.7, 0.3, 0.4, 0, Math.PI * 2); g.fill();
    g.restore();

    // Note 4 — recipe card / menu note (middle-right)
    g.save();
    g.translate(18, 17);
    g.rotate(-0.1);
    // Drop shadow
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(1.5, 1.5, 10, 9);
    g.fillStyle = '#f5ede0'; g.fillRect(0, 0, 10, 9);
    // Card border line
    g.strokeStyle = '#c4a882'; g.lineWidth = 0.4;
    g.strokeRect(0.5, 0.5, 9, 8);
    // Title area
    g.fillStyle = '#6b4226';
    g.fillRect(2, 1.5, 6, 0.8);
    // Dotted lines (recipe format)
    g.fillStyle = '#a89070';
    for (var li = 0; li < 4; li++) {
      for (var di = 0; di < 7; di++) {
        g.fillRect(1.5 + di * 1.1, 3.5 + li * 1.4, 0.6, 0.4);
      }
    }
    // Pin
    g.fillStyle = '#5c7090';
    g.beginPath(); g.arc(5, 0.5, 1.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#7090b0';
    g.beginPath(); g.arc(4.7, 0.3, 0.5, 0, Math.PI * 2); g.fill();
    g.restore();

    // Note 5 — small postcard (bottom-center)
    g.save();
    g.translate(8, 24);
    g.rotate(0.06);
    // Drop shadow
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(1.5, 1.5, 14, 6);
    g.fillStyle = '#e0d4c0'; g.fillRect(0, 0, 14, 6);
    // Stamp area (top-right of postcard)
    g.fillStyle = '#c9a070'; g.fillRect(10, 0.5, 3, 3);
    g.fillStyle = '#a08050'; g.fillRect(10.5, 1, 2, 2);
    // Address lines
    g.fillStyle = '#6b5a48';
    g.fillRect(1, 1.5, 7, 0.5);
    g.fillRect(1, 3, 6, 0.5);
    g.fillRect(1, 4.5, 5, 0.5);
    // Pin
    g.fillStyle = '#8b4040';
    g.beginPath(); g.arc(7, 0.5, 1, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#a05050';
    g.beginPath(); g.arc(6.7, 0.3, 0.4, 0, Math.PI * 2); g.fill();
    g.restore();

    // ── Cork texture extras — coffee ring stain + pin holes ──
    // Coffee ring stain (visible at phone scale — doubled opacity)
    g.strokeStyle = 'rgba(60,35,12,0.18)'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(25, 22, 3.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(60,35,12,0.08)'; g.lineWidth = 0.4;
    g.beginPath(); g.arc(25, 22, 3, 0, Math.PI * 2); g.stroke();

    // Old pin holes (where notes used to be, tiny dark dots)
    g.fillStyle = 'rgba(30,18,8,0.22)';
    var holes = [[6,13],[15,10],[22,14],[28,8],[10,27],[20,28]];
    for (var hi = 0; hi < holes.length; hi++) {
      g.beginPath(); g.arc(holes[hi][0], holes[hi][1], 0.3, 0, Math.PI * 2); g.fill();
    }

    // ── Pin shadows (cast down-right, bold for mobile legibility) ──
    g.fillStyle = 'rgba(0,0,0,0.18)';
    // Shadow positions offset from pin centers
    g.beginPath(); g.arc(9.5, 6, 1.2, 0, Math.PI * 2); g.fill();  // note 1 pin
    g.beginPath(); g.arc(23.5, 5, 1.2, 0, Math.PI * 2); g.fill();  // note 2 pin
    g.beginPath(); g.arc(9, 16.5, 1, 0, Math.PI * 2); g.fill();    // note 3 pin
    g.beginPath(); g.arc(24, 18.5, 1.2, 0, Math.PI * 2); g.fill(); // note 4 pin
    g.beginPath(); g.arc(16, 25.5, 1, 0, Math.PI * 2); g.fill();   // note 5 pin

    // ── Washi tape strip (on the postcard, colorful masking tape) ──
    g.save();
    g.translate(10, 23); g.rotate(0.06);
    g.fillStyle = 'rgba(120,180,160,0.2)'; // mint green tape
    g.fillRect(-1, 0, 6, 1.5);
    // Tape texture (translucent diagonal lines)
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(1, 1.5); g.stroke();
    g.beginPath(); g.moveTo(2, 0); g.lineTo(3, 1.5); g.stroke();
    g.restore();

    // ── Tiny business card (tucked behind newspaper clipping) ──
    g.save();
    g.translate(2, 21); g.rotate(-0.05);
    g.fillStyle = 'rgba(240,235,225,0.4)'; g.fillRect(0, 0, 7, 4);
    // Card text
    g.fillStyle = 'rgba(40,30,20,0.2)';
    g.fillRect(0.5, 0.8, 4, 0.4); // name
    g.fillStyle = 'rgba(40,30,20,0.1)';
    g.fillRect(0.5, 1.8, 5, 0.3);
    g.fillRect(0.5, 2.4, 3.5, 0.3);
    // Small logo square
    g.fillStyle = 'rgba(80,60,40,0.12)';
    g.fillRect(5, 0.5, 1.5, 1.5);
    g.restore();

    // ── String / fairy lights draped across top ──
    // Wire — darker and slightly thicker for visibility
    g.strokeStyle = 'rgba(25,15,8,0.6)'; g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(1, 2);
    g.quadraticCurveTo(8, 4.5, 16, 3);
    g.quadraticCurveTo(24, 5, 31, 2.5);
    g.stroke();

    // Bulbs along the wire (warm Edison micro-bulbs — glows boosted for mobile)
    var bulbs = [
      { x: 5,  y: 3.5, hue: '255,200,100' },
      { x: 10, y: 4.2, hue: '255,170,60'  },
      { x: 16, y: 3.2, hue: '255,215,130' },
      { x: 22, y: 4.5, hue: '255,185,75'  },
      { x: 27, y: 3.8, hue: '255,200,100' },
    ];
    for (var bi = 0; bi < bulbs.length; bi++) {
      var bl = bulbs[bi];
      // Outer soft glow (wide, warm pool on cork)
      var bulbGlow = g.createRadialGradient(bl.x, bl.y + 1, 0, bl.x, bl.y + 1, 5);
      bulbGlow.addColorStop(0,   'rgba(' + bl.hue + ',0.38)');
      bulbGlow.addColorStop(0.4, 'rgba(' + bl.hue + ',0.14)');
      bulbGlow.addColorStop(1,   'rgba(' + bl.hue + ',0)');
      g.fillStyle = bulbGlow;
      g.fillRect(bl.x - 5, bl.y - 4, 10, 10);
      // Bulb cap (dark socket on wire)
      g.fillStyle = 'rgba(20,12,5,0.7)';
      g.beginPath(); g.arc(bl.x, bl.y - 0.3, 0.8, 0, Math.PI * 2); g.fill();
      // Bulb glass body (fully opaque warm amber)
      g.fillStyle = 'rgba(' + bl.hue + ',1.0)';
      g.beginPath(); g.arc(bl.x, bl.y + 0.8, 1.3, 0, Math.PI * 2); g.fill();
      // Bright filament center (hot white)
      g.fillStyle = 'rgba(255,255,240,0.9)';
      g.beginPath(); g.arc(bl.x, bl.y + 0.8, 0.55, 0, Math.PI * 2); g.fill();
    }

    // ── Cork vignette — left/right edge darkening for depth ──
    var edgeShadowV = g.createLinearGradient(0, 0, 0, T);
    edgeShadowV.addColorStop(0,    'rgba(0,0,0,0.20)');
    edgeShadowV.addColorStop(0.08, 'rgba(0,0,0,0)');
    edgeShadowV.addColorStop(0.92, 'rgba(0,0,0,0)');
    edgeShadowV.addColorStop(1,    'rgba(0,0,0,0.15)');
    g.fillStyle = edgeShadowV; g.fillRect(0, 0, T, T);
    var edgeShadowH = g.createLinearGradient(0, 0, T, 0);
    edgeShadowH.addColorStop(0,    'rgba(0,0,0,0.12)');
    edgeShadowH.addColorStop(0.06, 'rgba(0,0,0,0)');
    edgeShadowH.addColorStop(0.94, 'rgba(0,0,0,0)');
    edgeShadowH.addColorStop(1,    'rgba(0,0,0,0.12)');
    g.fillStyle = edgeShadowH; g.fillRect(0, 0, T, T);

    return c;
  }

  function renderWarRoomDoor() {
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Heavy steel frame ──
    g.fillStyle = '#1a2228'; g.fillRect(0, 0, T, T);
    g.fillStyle = '#263238'; g.fillRect(1, 0, T - 2, T);

    // ── Steel door panel ──
    var dL = 3, dT = 1, dW = T - 6, dH = T - 2;
    // Brushed metal base
    g.fillStyle = '#3d4a52'; g.fillRect(dL, dT, dW, dH);
    // Horizontal brushed-metal lines
    g.strokeStyle = 'rgba(70,85,95,0.5)'; g.lineWidth = 0.4;
    for (var mi = 0; mi < 12; mi++) {
      var my = dT + 2 + mi * 2.5;
      g.beginPath(); g.moveTo(dL + 1, my); g.lineTo(dL + dW - 1, my); g.stroke();
    }

    // ── Reinforced window (wired glass) ──
    var wx = 8, wy = 4, ww = 14, wh = 10;
    // Window recess shadow (deep inset)
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);
    // Glass — war-room crimson interior, clearly visible
    var glassGrd = g.createLinearGradient(wx, wy, wx, wy + wh);
    glassGrd.addColorStop(0, '#2a0808');
    glassGrd.addColorStop(0.4, '#3a1010');
    glassGrd.addColorStop(1, '#1e0606');
    g.fillStyle = glassGrd; g.fillRect(wx, wy, ww, wh);
    // Primary red screen glow — bold, fills the glass
    var screenGlow = g.createRadialGradient(wx + ww * 0.35, wy + wh / 2, 0, wx + ww / 2, wy + wh / 2, 9);
    screenGlow.addColorStop(0, 'rgba(255,50,30,0.55)');
    screenGlow.addColorStop(0.5, 'rgba(220,30,20,0.25)');
    screenGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = screenGlow; g.fillRect(wx, wy, ww, wh);
    // Secondary blue monitor (right side — cold contrast)
    g.fillStyle = 'rgba(40,120,255,0.28)';
    g.fillRect(wx + ww - 5, wy + 1, 4, 5);
    // Blue monitor inner glow
    var blueGlow = g.createRadialGradient(wx + ww - 3, wy + 3.5, 0, wx + ww - 3, wy + 3.5, 4);
    blueGlow.addColorStop(0, 'rgba(80,160,255,0.2)');
    blueGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = blueGlow; g.fillRect(wx, wy, ww, wh);
    // Green terminal text lines (readable at 32px)
    g.fillStyle = 'rgba(0,230,100,0.22)';
    g.fillRect(wx + 2, wy + 2.5, 5, 0.7);
    g.fillRect(wx + 2, wy + 4.2, 3.5, 0.7);
    g.fillRect(wx + 2, wy + 5.9, 4.5, 0.7);
    g.fillRect(wx + 2, wy + 7.6, 2.5, 0.7);
    // Wire mesh pattern (safety glass — visible grid)
    g.strokeStyle = 'rgba(140,160,170,0.35)'; g.lineWidth = 0.4;
    for (var wi = 1; wi < 5; wi++) {
      g.beginPath(); g.moveTo(wx + wi * 3.5, wy); g.lineTo(wx + wi * 3.5, wy + wh); g.stroke();
    }
    for (var wj = 1; wj < 4; wj++) {
      g.beginPath(); g.moveTo(wx, wy + wj * 3.3); g.lineTo(wx + ww, wy + wj * 3.3); g.stroke();
    }
    // Glass reflection — angled bright slash
    g.strokeStyle = 'rgba(200,220,240,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(wx + 1.5, wy + 1); g.lineTo(wx + 5, wy + 5); g.stroke();
    // Thin secondary highlight
    g.strokeStyle = 'rgba(200,220,240,0.12)'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(wx + 3, wy + 1); g.lineTo(wx + 5.5, wy + 3); g.stroke();

    // ── Industrial handle (horizontal bar) ──
    var hx = dL + dW - 6, hy = T / 2 + 2;
    // Handle shadow
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(hx + 0.5, hy + 0.5, 4, 2);
    // Handle bar
    g.fillStyle = '#78909c'; g.fillRect(hx, hy, 4, 1.5);
    // Handle highlight
    g.fillStyle = 'rgba(200,220,230,0.2)'; g.fillRect(hx, hy, 4, 0.5);
    // Mount points
    g.fillStyle = '#546e7a';
    g.fillRect(hx, hy - 1, 1.5, 3.5);
    g.fillRect(hx + 2.5, hy - 1, 1.5, 3.5);

    // ── Rivets (industrial detail) ──
    g.fillStyle = '#546e7a';
    var rivets = [[5,3],[dL+dW-3,3],[5,T-4],[dL+dW-3,T-4]];
    for (var ri = 0; ri < rivets.length; ri++) {
      g.beginPath(); g.arc(rivets[ri][0], rivets[ri][1], 1, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(200,220,230,0.15)';
      g.beginPath(); g.arc(rivets[ri][0] - 0.3, rivets[ri][1] - 0.3, 0.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#546e7a';
    }

    // ── Access keypad (left side of door) ──
    g.fillStyle = '#1e272c'; g.fillRect(dL + 1, T / 2 + 1, 4, 6);
    // Keypad border highlight
    g.strokeStyle = 'rgba(80,100,110,0.5)'; g.lineWidth = 0.5;
    g.strokeRect(dL + 1, T / 2 + 1, 4, 6);
    // Keypad screen (glowing green LCD)
    g.fillStyle = '#0a1a0a'; g.fillRect(dL + 1.5, T / 2 + 1.5, 3, 1.5);
    g.fillStyle = 'rgba(0,220,100,0.7)'; g.fillRect(dL + 2, T / 2 + 2, 2, 0.5);
    // Green screen ambient glow
    g.fillStyle = 'rgba(0,200,80,0.12)'; g.fillRect(dL + 1, T / 2 + 1, 4, 3);
    // Button grid (2x2) — slightly lighter so they read
    g.fillStyle = '#4a5a64';
    g.fillRect(dL + 1.5, T / 2 + 3.5, 1.2, 1);
    g.fillRect(dL + 3, T / 2 + 3.5, 1.2, 1);
    g.fillRect(dL + 1.5, T / 2 + 5, 1.2, 0.8);
    g.fillRect(dL + 3, T / 2 + 5, 1.2, 0.8);
    // Status LED (armed — red dot above keypad)
    g.fillStyle = '#ff2020';
    g.beginPath(); g.arc(dL + 3, T / 2 - 0.5, 0.8, 0, Math.PI * 2); g.fill();
    // LED glow halo
    var ledGlow = g.createRadialGradient(dL + 3, T / 2 - 0.5, 0, dL + 3, T / 2 - 0.5, 2.5);
    ledGlow.addColorStop(0, 'rgba(255,40,20,0.4)');
    ledGlow.addColorStop(1, 'rgba(255,0,0,0)');
    g.fillStyle = ledGlow; g.fillRect(dL, T / 2 - 3, 7, 5);

    // ── Small warning label (bottom of door) ──
    g.fillStyle = '#d4a020'; g.fillRect(dL + 5, T - 7, 8, 3);
    g.fillStyle = '#1a1a1a';
    // Tiny exclamation triangle
    g.beginPath();
    g.moveTo(dL + 9, T - 6.5);
    g.lineTo(dL + 10.5, T - 4.5);
    g.lineTo(dL + 7.5, T - 4.5);
    g.closePath(); g.fill();
    g.fillStyle = '#d4a020';
    g.fillRect(dL + 8.8, T - 6, 0.5, 1);

    // ── Ventilation slats (lower door, industrial cooling) ──
    var ventY = T - 12, ventX = dL + 2, ventW = 8;
    for (var vi = 0; vi < 4; vi++) {
      var vy = ventY + vi * 1.8;
      // Slat opening (dark gap)
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(ventX, vy, ventW, 0.8);
      // Slat louver (angled metal)
      g.fillStyle = 'rgba(80,95,105,0.5)';
      g.fillRect(ventX, vy - 0.3, ventW, 0.5);
    }

    // ── Cable conduit (runs along right frame edge) ──
    g.strokeStyle = 'rgba(50,60,70,0.4)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(T - 3, 5); g.lineTo(T - 3, T - 3); g.stroke();
    // Conduit clamp brackets
    g.fillStyle = '#4a5a64';
    g.fillRect(T - 4, 8, 2.5, 1.5);
    g.fillRect(T - 4, 20, 2.5, 1.5);
    // Cable junction box (small rectangle)
    g.fillStyle = '#3a4a54';
    g.fillRect(T - 5, 14, 3, 3);
    g.fillStyle = 'rgba(200,220,230,0.08)';
    g.fillRect(T - 5, 14, 3, 0.5);

    // ── "AUTHORIZED ONLY" stencil text (visible worn paint on door) ──
    // Two stencil-style bars — readable as text at 32px
    g.fillStyle = 'rgba(220,60,40,0.22)';
    g.fillRect(dL + 5, T / 2 - 2.5, 12, 1);
    g.fillRect(dL + 7, T / 2 - 0.8, 8, 1);
    // Worn/chipped edges on stencil (adds age)
    g.fillStyle = 'rgba(0,0,0,0.1)';
    g.fillRect(dL + 5, T / 2 - 2.5, 2, 1);
    g.fillRect(dL + 14, T / 2 - 0.8, 1, 1);

    // ── Edge shadow ──
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(dL, dT, 1, dH);

    // ── Red light spill under door (war room glow leaking out) ──
    var redSpill = g.createLinearGradient(0, T - 3, 0, T);
    redSpill.addColorStop(0, 'rgba(255,40,30,0)');
    redSpill.addColorStop(0.5, 'rgba(255,40,30,0.18)');
    redSpill.addColorStop(1, 'rgba(255,50,35,0.32)');
    g.fillStyle = redSpill; g.fillRect(dL, T - 3, dW, 3);
    // Spill also bleeds onto the floor edge (outside frame)
    var floorSpill = g.createLinearGradient(0, T - 1, 0, T);
    floorSpill.addColorStop(0, 'rgba(255,40,30,0.15)');
    floorSpill.addColorStop(1, 'rgba(255,40,30,0)');
    g.fillStyle = floorSpill; g.fillRect(0, T - 1, T, 1);

    return c;
  }

  function renderCatWindow() {
    var c = makeCanvas(), g = c.getContext('2d');

    // ── Outer frame (same thick wood as main windows) ──
    g.fillStyle = '#4a2e1e'; g.fillRect(0, 0, T, T);
    g.fillStyle = 'rgba(70,45,30,0.3)';
    g.fillRect(0, 1, T, 1); g.fillRect(0, T - 2, T, 1);
    // Inner frame shadow
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(3, 3, T - 6, 1); g.fillRect(3, 3, 1, T - 10);

    // ── Glass area (taller — sill is lower) ──
    var gx = 4, gy = 4, gw = T - 8, gh = T - 12;
    var skyGrd = g.createLinearGradient(gx, gy, gx, gy + gh);
    skyGrd.addColorStop(0, '#080c16');
    skyGrd.addColorStop(0.5, '#0e1525');
    skyGrd.addColorStop(1, '#141e35');
    g.fillStyle = skyGrd; g.fillRect(gx, gy, gw, gh);

    // ── Crescent moon (upper right) ──
    g.fillStyle = 'rgba(230,225,200,0.6)';
    g.beginPath(); g.arc(22, 7, 3, 0, Math.PI * 2); g.fill();
    // Cut-out to make crescent
    g.fillStyle = skyGrd;
    g.beginPath(); g.arc(23.5, 6, 3, 0, Math.PI * 2); g.fill();
    // Moon glow halo
    var moonGlow = g.createRadialGradient(22, 7, 1, 22, 7, 7);
    moonGlow.addColorStop(0, 'rgba(200,190,150,0.12)');
    moonGlow.addColorStop(0.5, 'rgba(180,170,130,0.04)');
    moonGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = moonGlow; g.fillRect(gx, gy, gw, gh);

    // ── Stars (varied sizes and brightness) ──
    // Bright stars
    g.fillStyle = 'rgba(255,255,210,0.6)';
    g.fillRect(8, 6, 1, 1);
    g.fillStyle = 'rgba(255,255,210,0.45)';
    g.fillRect(14, 5, 1, 1);
    // Medium stars
    g.fillStyle = 'rgba(255,255,200,0.3)';
    g.fillRect(6, 9, 1, 1); g.fillRect(18, 11, 1, 1);
    // Dim distant stars (sub-pixel feel)
    g.fillStyle = 'rgba(200,210,255,0.15)';
    g.fillRect(10, 8, 1, 1); g.fillRect(25, 6, 1, 1);
    g.fillRect(12, 11, 1, 1); g.fillRect(7, 13, 1, 1);
    // Warm star near moon
    g.fillStyle = 'rgba(255,220,150,0.25)';
    g.fillRect(18, 7, 1, 1);

    // ── Drifting cloud wisps (thin cirrus clouds catching moonlight) ──
    g.strokeStyle = 'rgba(140,150,170,0.06)'; g.lineWidth = 1.2;
    // Cloud wisp 1 (upper left, long thin streak)
    g.beginPath();
    g.moveTo(gx, gy + 4);
    g.quadraticCurveTo(gx + 6, gy + 3, gx + 12, gy + 5);
    g.stroke();
    // Cloud wisp 2 (middle, shorter)
    g.strokeStyle = 'rgba(140,150,170,0.04)'; g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(gx + 10, gy + 8);
    g.quadraticCurveTo(gx + 14, gy + 7, gx + 18, gy + 9);
    g.stroke();
    // Cloud wisp 3 (near moon, very faint — moon-lit edge)
    g.strokeStyle = 'rgba(200,190,160,0.05)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(18, gy + 5);
    g.quadraticCurveTo(21, gy + 4, 25, gy + 6);
    g.stroke();

    // ── Aurora shimmer (faint green-violet curtain above treeline) ──
    // Aurora is a vertical gradient band between treeline and mid-sky
    var auroraY = gy + gh - 10;
    var auroraGrd = g.createLinearGradient(gx, auroraY, gx, auroraY + 8);
    auroraGrd.addColorStop(0, 'rgba(60,200,120,0)');
    auroraGrd.addColorStop(0.3, 'rgba(60,200,120,0.03)');
    auroraGrd.addColorStop(0.6, 'rgba(100,120,200,0.02)');
    auroraGrd.addColorStop(1, 'rgba(100,80,180,0)');
    g.fillStyle = auroraGrd; g.fillRect(gx + 2, auroraY, gw - 4, 8);
    // Aurora vertical streaks (curtain effect — 3 faint columns)
    g.strokeStyle = 'rgba(80,220,140,0.03)'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(gx + 4, auroraY + 1); g.lineTo(gx + 5, auroraY + 6); g.stroke();
    g.beginPath(); g.moveTo(gx + 10, auroraY); g.lineTo(gx + 11, auroraY + 7); g.stroke();
    g.beginPath(); g.moveTo(gx + 17, auroraY + 1); g.lineTo(gx + 16, auroraY + 6); g.stroke();

    // ── Distant treeline silhouette (bottom of glass) ──
    g.fillStyle = 'rgba(5,10,20,0.8)';
    g.beginPath();
    g.moveTo(gx, gy + gh - 1);
    // Gentle tree canopy undulation
    g.lineTo(gx + 2, gy + gh - 3);
    g.lineTo(gx + 4, gy + gh - 5);
    g.lineTo(gx + 6, gy + gh - 3);
    g.lineTo(gx + 8, gy + gh - 4);
    g.lineTo(gx + 10, gy + gh - 6);
    g.lineTo(gx + 12, gy + gh - 4);
    g.lineTo(gx + 14, gy + gh - 2);
    g.lineTo(gx + 16, gy + gh - 5);
    g.lineTo(gx + 18, gy + gh - 3);
    g.lineTo(gx + 20, gy + gh - 4);
    g.lineTo(gx + 22, gy + gh - 2);
    g.lineTo(gx + gw, gy + gh - 1);
    g.lineTo(gx + gw, gy + gh);
    g.lineTo(gx, gy + gh);
    g.closePath();
    g.fill();

    // ── Rain streaks on glass — moonlit water catching silver light ──
    var catStreaks = [
      // [x1, y1, x2, y2, opacity, width]
      [10, 5,  9.5, 14, 0.38, 0.8],
      [20, 4,  19,  12, 0.32, 0.7],
      [15, 6,  14.5,11, 0.28, 0.6],
      [26, 5,  25.5,10, 0.22, 0.5],
      // Extra fine moonlit streaks
      [7,  8,  6.5, 15, 0.18, 0.5],
      [23, 7,  22.5,13, 0.16, 0.4],
    ];
    for (var csi = 0; csi < catStreaks.length; csi++) {
      var css = catStreaks[csi];
      // Main water body — cooler, moonlit blue
      g.strokeStyle = 'rgba(180,210,235,' + css[4] + ')';
      g.lineWidth = css[5];
      g.beginPath(); g.moveTo(css[0], css[1]); g.lineTo(css[2], css[3]); g.stroke();
      // Moon-catch glint — pale silver edge on right side of streak
      g.strokeStyle = 'rgba(230,240,255,' + (css[4] * 0.40).toFixed(2) + ')';
      g.lineWidth = 0.25;
      g.beginPath(); g.moveTo(css[0] + 0.4, css[1] + 1); g.lineTo(css[2] + 0.4, css[3] - 1); g.stroke();
    }
    // Droplets at streak ends — moonlit with silver specular
    var catDroplets = [
      [9.5, 14.5, 0.85, 0.32],
      [19,  12.5, 0.70, 0.28],
      [25.5,10.5, 0.60, 0.22],
      [6.5, 15.0, 0.55, 0.18],
    ];
    for (var cdi = 0; cdi < catDroplets.length; cdi++) {
      var cdp = catDroplets[cdi];
      var cdGrd = g.createRadialGradient(cdp[0] - cdp[2]*0.25, cdp[1] - cdp[2]*0.25, 0, cdp[0], cdp[1], cdp[2]);
      cdGrd.addColorStop(0, 'rgba(220,238,255,' + (cdp[3]*0.9).toFixed(2) + ')');
      cdGrd.addColorStop(0.6,'rgba(175,210,235,' + cdp[3] + ')');
      cdGrd.addColorStop(1,  'rgba(130,180,220,' + (cdp[3]*0.4).toFixed(2) + ')');
      g.fillStyle = cdGrd;
      g.beginPath(); g.arc(cdp[0], cdp[1], cdp[2], 0, Math.PI * 2); g.fill();
      // Silver moon-catch on drop
      g.fillStyle = 'rgba(240,250,255,0.70)';
      g.beginPath(); g.arc(cdp[0] - cdp[2]*0.3, cdp[1] - cdp[2]*0.3, cdp[2]*0.28, 0, Math.PI * 2); g.fill();
    }

    // ── Condensation fog on lower glass — two-layer frosted depth ──
    var fogGrd = g.createLinearGradient(gx, gy + gh - 9, gx, gy + gh);
    fogGrd.addColorStop(0,    'rgba(175,200,225,0)');
    fogGrd.addColorStop(0.30, 'rgba(178,203,228,0.12)');
    fogGrd.addColorStop(0.65, 'rgba(188,210,232,0.30)');
    fogGrd.addColorStop(1,    'rgba(205,222,240,0.48)');
    g.fillStyle = fogGrd; g.fillRect(gx, gy + gh - 9, gw, 9);
    // Warm amber bleed from interior through condensation
    var catFogWarm = g.createLinearGradient(gx, gy + gh - 5, gx, gy + gh);
    catFogWarm.addColorStop(0, 'rgba(255,175,70,0)');
    catFogWarm.addColorStop(1, 'rgba(255,155,50,0.10)');
    g.fillStyle = catFogWarm; g.fillRect(gx, gy + gh - 5, gw, 5);
    // Fog upper boundary line
    g.strokeStyle = 'rgba(215,232,248,0.22)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(gx + 1, gy + gh - 9); g.lineTo(gx + gw - 1, gy + gh - 9); g.stroke();
    // Condensation drip trails — 3 runs, moonlit silver
    var catCTrails = [
      { x: 8.0,  y0: gy+gh-7, ctrl: 8.6  },
      { x: 17.5, y0: gy+gh-8, ctrl: 17.0 },
      { x: 25.0, y0: gy+gh-6, ctrl: 25.4 },
    ];
    for (var ccti = 0; ccti < catCTrails.length; ccti++) {
      var cct = catCTrails[ccti];
      g.strokeStyle = 'rgba(185,218,242,0.50)'; g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(cct.x, cct.y0);
      g.quadraticCurveTo(cct.ctrl, cct.y0 + (gy+gh - cct.y0)*0.5, cct.x, gy + gh);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 0.2;
      g.beginPath();
      g.moveTo(cct.x - 0.3, cct.y0 + 1);
      g.quadraticCurveTo(cct.ctrl - 0.3, cct.y0 + (gy+gh - cct.y0)*0.5, cct.x - 0.3, gy + gh - 1);
      g.stroke();
      // Bead
      g.fillStyle = 'rgba(210,235,252,0.65)';
      g.beginPath(); g.arc(cct.x, gy + gh - 0.5, 0.7, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.70)';
      g.beginPath(); g.arc(cct.x - 0.2, gy + gh - 0.8, 0.22, 0, Math.PI * 2); g.fill();
    }

    // ── Glass reflection (diagonal glint) ──
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(gx + 1, gy + 1); g.lineTo(gx + 7, gy + 7); g.stroke();
    // Secondary smaller reflection
    g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(gx + 3, gy + 1); g.lineTo(gx + 8, gy + 5); g.stroke();

    // ── Interior warmth bleed onto glass bottom — warm cafe light from below ──
    // The cafe interior is warm amber; it lights the bottom of the glass from inside
    var warmBleed = g.createLinearGradient(gx, gy + gh - 10, gx, gy + gh);
    warmBleed.addColorStop(0, 'rgba(255,160,60,0)');
    warmBleed.addColorStop(0.5, 'rgba(255,150,50,0.10)');
    warmBleed.addColorStop(1, 'rgba(255,130,40,0.22)');
    g.fillStyle = warmBleed; g.fillRect(gx, gy + gh - 10, gw, 10);

    // ── Wooden sill (deep, warm) ──
    var sillY = gy + gh;
    // Sill top surface — lit by interior light, brighter around cat
    g.fillStyle = '#7a5542'; g.fillRect(3, sillY, T - 6, 5);
    // Strong warm pool under cat — the interior lamp hits the sill here
    var sillPool = g.createRadialGradient(T / 2, sillY + 1, 0, T / 2, sillY + 1, 9);
    sillPool.addColorStop(0, 'rgba(255,200,100,0.30)');
    sillPool.addColorStop(0.5, 'rgba(255,160,60,0.14)');
    sillPool.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sillPool; g.fillRect(3, sillY, T - 6, 5);
    // Sill top-edge highlight (catches overhead light)
    g.fillStyle = 'rgba(255,220,160,0.22)'; g.fillRect(3, sillY, T - 6, 1);
    // Sill front face (slightly darker, facing down)
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(3, sillY + 4, T - 6, 1);
    // Wood grain on sill
    g.strokeStyle = 'rgba(90,55,35,0.18)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(4, sillY + 2); g.lineTo(T - 4, sillY + 2); g.stroke();
    g.beginPath(); g.moveTo(4, sillY + 3.5); g.lineTo(T - 4, sillY + 3.5); g.stroke();

    // ── Cat silhouette on windowsill ──
    // Sitting cat — ears, head, body curve, tail
    var catX = T / 2 - 1, catY = sillY - 1;

    // Tail (curls to the right, starts from body)
    g.strokeStyle = '#1a1210'; g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(catX + 4, catY);
    g.quadraticCurveTo(catX + 8, catY - 1, catX + 9, catY - 4);
    g.stroke();
    // Tail tip
    g.strokeStyle = '#1a1210'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(catX + 9, catY - 4);
    g.quadraticCurveTo(catX + 10, catY - 6, catX + 8, catY - 6);
    g.stroke();

    // Body (rounded sitting shape)
    g.fillStyle = '#1a1210';
    g.beginPath();
    g.ellipse(catX + 2, catY, 4, 3, 0, 0, Math.PI, true);
    g.fill();

    // Head (circle, slightly overlapping body top)
    g.fillStyle = '#1a1210';
    g.beginPath(); g.arc(catX + 2, catY - 5, 3, 0, Math.PI * 2); g.fill();

    // Ears (triangles)
    g.fillStyle = '#1a1210';
    // Left ear
    g.beginPath();
    g.moveTo(catX - 0.5, catY - 7);
    g.lineTo(catX - 1.5, catY - 10);
    g.lineTo(catX + 1.5, catY - 7.5);
    g.fill();
    // Right ear
    g.beginPath();
    g.moveTo(catX + 3.5, catY - 7.5);
    g.lineTo(catX + 5, catY - 10);
    g.lineTo(catX + 5, catY - 7);
    g.fill();

    // Inner ears — warm pink, lit from inside
    g.fillStyle = 'rgba(180,90,75,0.45)';
    g.beginPath();
    g.moveTo(catX, catY - 7.5);
    g.lineTo(catX - 0.5, catY - 9);
    g.lineTo(catX + 1, catY - 7.5);
    g.fill();
    g.beginPath();
    g.moveTo(catX + 4, catY - 7.5);
    g.lineTo(catX + 4.5, catY - 9);
    g.lineTo(catX + 4.5, catY - 7.5);
    g.fill();

    // ── Warm rim-light on cat's right edge (interior lamp behind it) ──
    // The cafe light comes from the right/behind — amber fringe on the silhouette
    g.strokeStyle = 'rgba(255,170,60,0.32)'; g.lineWidth = 1;
    // Right body edge
    g.beginPath();
    g.arc(catX + 2, catY, 4.2, -Math.PI * 0.6, 0.1);
    g.stroke();
    // Right head arc
    g.beginPath();
    g.arc(catX + 2, catY - 5, 3.2, -Math.PI * 0.5, Math.PI * 0.3);
    g.stroke();
    // Right ear outer edge
    g.strokeStyle = 'rgba(255,160,50,0.22)'; g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(catX + 4.5, catY - 7.5);
    g.lineTo(catX + 5.2, catY - 10.2);
    g.stroke();

    // Eyes (two tiny glowing dots — cat watching the rain)
    g.fillStyle = '#d4b030';
    g.fillRect(catX, catY - 5, 1, 1);
    g.fillRect(catX + 3, catY - 5, 1, 1);
    // Eye glow — brighter, reads at mobile scale
    g.fillStyle = 'rgba(220,180,60,0.40)';
    g.fillRect(catX - 0.5, catY - 5.5, 2, 2);
    g.fillRect(catX + 2.5, catY - 5.5, 2, 2);

    // Whiskers — slightly brighter, warm light catches them
    g.strokeStyle = 'rgba(80,65,50,0.45)'; g.lineWidth = 0.3;
    // Left whiskers
    g.beginPath(); g.moveTo(catX - 0.5, catY - 4); g.lineTo(catX - 4, catY - 5); g.stroke();
    g.beginPath(); g.moveTo(catX - 0.5, catY - 3.5); g.lineTo(catX - 4.5, catY - 3.5); g.stroke();
    g.beginPath(); g.moveTo(catX - 0.5, catY - 3); g.lineTo(catX - 3.5, catY - 2); g.stroke();
    // Right whiskers (lit side — warmer tint)
    g.strokeStyle = 'rgba(180,130,60,0.40)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(catX + 4.5, catY - 4); g.lineTo(catX + 8, catY - 5); g.stroke();
    g.beginPath(); g.moveTo(catX + 4.5, catY - 3.5); g.lineTo(catX + 8.5, catY - 3.5); g.stroke();
    g.beginPath(); g.moveTo(catX + 4.5, catY - 3); g.lineTo(catX + 7.5, catY - 2); g.stroke();

    // ── Cat shadow cast on sill (interior light source above-right) ──
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.ellipse(catX + 4, sillY + 3, 5, 1.5, 0.2, 0, Math.PI * 2);
    g.fill();

    // ── Final ambient interior warmth tint on glass ──
    // Subtle but present: 0.07 reads at mobile vs previous invisible 0.02
    g.fillStyle = 'rgba(255,180,80,0.07)'; g.fillRect(gx, gy, gw, gh);

    return c;
  }

  function renderCoffeeMachineBase() {
    var c = makeCanvas(), g = c.getContext('2d');
    // Counter surface underneath
    var counter = renderCounter();
    g.drawImage(counter, 0, 0);

    // ── Espresso machine body ──
    var mL = 6, mT = 3, mW = 20, mH = 21;

    // Hard drop shadow — gives weight on the counter
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(mL + 2, mT + mH, mW - 1, 4);
    g.fillStyle = 'rgba(0,0,0,0.20)';
    g.fillRect(mL + 4, mT + mH + 3, mW - 4, 2);

    // ── Pendant lamp bloom hitting the top chrome ──
    var topBloom = g.createRadialGradient(mL + mW * 0.5, mT - 2, 0, mL + mW * 0.5, mT + 4, 14);
    topBloom.addColorStop(0,   'rgba(255,220,140,0.55)');
    topBloom.addColorStop(0.4, 'rgba(255,200,100,0.20)');
    topBloom.addColorStop(1,   'rgba(0,0,0,0)');
    g.fillStyle = topBloom;
    g.fillRect(mL - 2, mT - 4, mW + 4, 14);

    // Main body — brushed chrome, strong left-to-right highlight
    var bodyGrd = g.createLinearGradient(mL, mT, mL + mW, mT);
    bodyGrd.addColorStop(0,    '#606060');   // left shadow edge
    bodyGrd.addColorStop(0.18, '#909090');
    bodyGrd.addColorStop(0.38, '#d4d4d4');   // pendant highlight peak
    bodyGrd.addColorStop(0.55, '#e8e8e8');   // specular centre
    bodyGrd.addColorStop(0.72, '#b8b8b8');
    bodyGrd.addColorStop(1,    '#5a5a5a');   // right shadow edge
    g.fillStyle = bodyGrd;
    g.fillRect(mL, mT, mW, mH);

    // Vertical brushed-steel striations (mimic linear brushing)
    g.strokeStyle = 'rgba(255,255,255,0.09)'; g.lineWidth = 0.5;
    for (var sx = mL + 2; sx < mL + mW - 1; sx += 2.5) {
      g.beginPath(); g.moveTo(sx, mT + 1); g.lineTo(sx, mT + mH - 1); g.stroke();
    }

    // Top cap — darker steel ridge with bright pendant streak across it
    g.fillStyle = '#484848';
    g.fillRect(mL - 1, mT, mW + 2, 3);
    // Pendant light streak on top cap
    var capStreakGrd = g.createLinearGradient(mL, mT, mL + mW, mT);
    capStreakGrd.addColorStop(0,    'rgba(255,255,255,0)');
    capStreakGrd.addColorStop(0.35, 'rgba(255,240,180,0.75)');
    capStreakGrd.addColorStop(0.55, 'rgba(255,255,255,0.90)');
    capStreakGrd.addColorStop(0.75, 'rgba(255,240,180,0.55)');
    capStreakGrd.addColorStop(1,    'rgba(255,255,255,0)');
    g.fillStyle = capStreakGrd;
    g.fillRect(mL - 1, mT, mW + 2, 1.5);

    // Thin bright rim below top cap
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(mL, mT + 3, mW, 1);

    // ── Brand badge (copper plate) ──
    g.fillStyle = '#9a6f00';
    g.fillRect(mL + 5, mT + 5, 10, 4);
    var badgeGrd = g.createLinearGradient(mL + 5, mT + 5, mL + 5, mT + 9);
    badgeGrd.addColorStop(0,   '#daa520');
    badgeGrd.addColorStop(0.5, '#b8860b');
    badgeGrd.addColorStop(1,   '#7a5500');
    g.fillStyle = badgeGrd;
    g.fillRect(mL + 5, mT + 5, 10, 4);
    // Badge highlight
    g.fillStyle = 'rgba(255,220,100,0.55)';
    g.fillRect(mL + 5, mT + 5, 10, 1);
    // Simulated THINKER lettering lines
    g.fillStyle = 'rgba(255,245,200,0.65)';
    g.fillRect(mL + 6,  mT + 6.5, 8, 0.8);
    g.fillRect(mL + 7,  mT + 7.8, 5, 0.6);

    // ── Group head / portafilter ──
    var ghY = mT + 12;

    // Group head — chrome disc (filled first, then bright ring)
    g.fillStyle = '#383838';
    g.beginPath(); g.arc(mL + 10, ghY + 2, 4.5, 0, Math.PI * 2); g.fill();
    // Chrome outer ring
    var ghRing = g.createRadialGradient(mL + 9, ghY + 1, 1, mL + 10, ghY + 2, 4.5);
    ghRing.addColorStop(0,   '#d8d8d8');
    ghRing.addColorStop(0.6, '#a0a0a0');
    ghRing.addColorStop(1,   '#606060');
    g.strokeStyle = ghRing; g.lineWidth = 1.5;
    g.beginPath(); g.arc(mL + 10, ghY + 2, 4.5, 0, Math.PI * 2); g.stroke();
    // Inner dark disc (basket)
    g.fillStyle = '#282828';
    g.beginPath(); g.arc(mL + 10, ghY + 2, 2.8, 0, Math.PI * 2); g.fill();
    // Highlight on basket top
    g.fillStyle = 'rgba(180,180,180,0.5)';
    g.beginPath(); g.arc(mL + 9.5, ghY + 1, 1.2, 0, Math.PI * 2); g.fill();

    // Portafilter handle — dark wood, extends right
    g.fillStyle = '#1a0e06';
    g.fillRect(mL + 14, ghY, 9, 3);
    var pfGrd = g.createLinearGradient(mL + 14, ghY, mL + 14, ghY + 3);
    pfGrd.addColorStop(0,   '#4a2e14');
    pfGrd.addColorStop(0.4, '#2c1a08');
    pfGrd.addColorStop(1,   '#120800');
    g.fillStyle = pfGrd;
    g.fillRect(mL + 14, ghY, 9, 3);
    // Handle sheen
    g.fillStyle = 'rgba(180,120,60,0.35)';
    g.fillRect(mL + 14, ghY, 9, 1);
    // Collar chrome ring where handle meets group head
    g.fillStyle = '#c0c0c0';
    g.fillRect(mL + 14, ghY - 0.5, 1.5, 4);

    // Drip tray
    g.fillStyle = '#1e1e1e';
    g.fillRect(mL + 3, ghY + 7, 14, 3);
    // Tray grill lines
    g.strokeStyle = '#383838'; g.lineWidth = 0.6;
    for (var tx = mL + 4; tx < mL + 17; tx += 2) {
      g.beginPath(); g.moveTo(tx, ghY + 7); g.lineTo(tx, ghY + 10); g.stroke();
    }
    // Tray highlight rim
    g.fillStyle = 'rgba(160,160,160,0.5)';
    g.fillRect(mL + 3, ghY + 7, 14, 0.8);

    // ── Steam wand (left side, chrome) ──
    g.strokeStyle = '#c0c0c0'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(mL + 1, mT + 9); g.lineTo(mL - 3, mT + 18); g.stroke();
    // Wand highlight
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(mL + 0.5, mT + 9); g.lineTo(mL - 2.5, mT + 18); g.stroke();
    // Wand tip nozzle
    g.fillStyle = '#a0a0a0';
    g.beginPath(); g.arc(mL - 3, mT + 18, 1.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e0e0e0';
    g.beginPath(); g.arc(mL - 3.2, mT + 17.5, 0.7, 0, Math.PI * 2); g.fill();

    // ── Pressure gauges ──
    // Left gauge (water pressure)
    var g2x = mL + 5, g2y = mT + 6;
    // Outer bezel
    g.fillStyle = '#303030';
    g.beginPath(); g.arc(g2x, g2y, 2.5, 0, Math.PI * 2); g.fill();
    // White face
    g.fillStyle = '#f5f5f5';
    g.beginPath(); g.arc(g2x, g2y, 2, 0, Math.PI * 2); g.fill();
    // Bezel ring highlight
    g.strokeStyle = '#888'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(g2x, g2y, 2.5, 0, Math.PI * 2); g.stroke();
    // Red needle
    g.strokeStyle = '#dd0000'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(g2x, g2y); g.lineTo(g2x - 1.3, g2y - 1.0); g.stroke();
    // Pivot dot
    g.fillStyle = '#222';
    g.beginPath(); g.arc(g2x, g2y, 0.5, 0, Math.PI * 2); g.fill();

    // Right gauge (boiler pressure)
    var gaugeX = mL + 16, gaugeY = mT + 6;
    g.fillStyle = '#303030';
    g.beginPath(); g.arc(gaugeX, gaugeY, 2.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f0f0f0';
    g.beginPath(); g.arc(gaugeX, gaugeY, 2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#888'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(gaugeX, gaugeY, 2.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#dd0000'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(gaugeX, gaugeY); g.lineTo(gaugeX + 1.4, gaugeY - 0.8); g.stroke();
    g.fillStyle = '#222';
    g.beginPath(); g.arc(gaugeX, gaugeY, 0.5, 0, Math.PI * 2); g.fill();

    // ── LED indicator lights — BIG, glowing, unmissable ──
    // Power LED (green)
    var led1x = mL + 3, led1y = mT + 11;
    var ledGlow1 = g.createRadialGradient(led1x, led1y, 0, led1x, led1y, 4);
    ledGlow1.addColorStop(0,   'rgba(80,255,80,1.0)');
    ledGlow1.addColorStop(0.3, 'rgba(50,220,50,0.8)');
    ledGlow1.addColorStop(0.6, 'rgba(20,180,20,0.3)');
    ledGlow1.addColorStop(1,   'rgba(0,0,0,0)');
    g.fillStyle = ledGlow1;
    g.beginPath(); g.arc(led1x, led1y, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#50ff50';
    g.beginPath(); g.arc(led1x, led1y, 1.5, 0, Math.PI * 2); g.fill();
    // LED specular dot
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(led1x - 0.4, led1y - 0.4, 0.5, 0, Math.PI * 2); g.fill();

    // Heat-ready LED (amber/orange)
    var led2x = mL + 3, led2y = mT + 14;
    var ledGlow2 = g.createRadialGradient(led2x, led2y, 0, led2x, led2y, 4);
    ledGlow2.addColorStop(0,   'rgba(255,180,30,1.0)');
    ledGlow2.addColorStop(0.3, 'rgba(255,140,10,0.75)');
    ledGlow2.addColorStop(0.6, 'rgba(200,80,0,0.3)');
    ledGlow2.addColorStop(1,   'rgba(0,0,0,0)');
    g.fillStyle = ledGlow2;
    g.beginPath(); g.arc(led2x, led2y, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffb41e';
    g.beginPath(); g.arc(led2x, led2y, 1.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); g.arc(led2x - 0.4, led2y - 0.4, 0.5, 0, Math.PI * 2); g.fill();

    // ── Steam wisps above machine ──
    g.strokeStyle = 'rgba(220,220,220,0.50)'; g.lineWidth = 1.0;
    g.beginPath(); g.moveTo(mL + 8, mT - 1);
    g.quadraticCurveTo(mL + 5, mT - 4, mL + 9, mT - 7); g.stroke();
    g.strokeStyle = 'rgba(220,220,220,0.35)'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(mL + 13, mT - 1);
    g.quadraticCurveTo(mL + 16, mT - 4, mL + 12, mT - 7); g.stroke();
    g.strokeStyle = 'rgba(220,220,220,0.22)'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(mL + 10, mT);
    g.quadraticCurveTo(mL + 8, mT - 3, mL + 11, mT - 5); g.stroke();

    // ── Cup on drip tray ──
    var cupX = mL + 7, cupY = ghY + 4;
    // Cup body (ceramic white/cream)
    g.fillStyle = '#f5edd8';
    g.fillRect(cupX, cupY, 5, 4);
    // Coffee surface
    g.fillStyle = '#2a1508';
    g.fillRect(cupX + 0.5, cupY + 0.5, 4, 1.5);
    // Crema layer
    g.fillStyle = 'rgba(180,100,20,0.7)';
    g.fillRect(cupX + 0.5, cupY + 0.5, 4, 0.6);
    // Cup rim highlight
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillRect(cupX, cupY, 5, 0.8);
    // Handle
    g.strokeStyle = '#e8dcc0'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(cupX + 6, cupY + 2, 1.8, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
    // Saucer
    g.fillStyle = '#e8dcc0';
    g.fillRect(cupX - 1, cupY + 4, 7, 1);

    // ── Final top-chrome specular overlay ──
    // Bright narrow streak across the very top of the machine body
    var topSpec = g.createLinearGradient(mL, mT + 3, mL + mW, mT + 3);
    topSpec.addColorStop(0,    'rgba(255,255,255,0)');
    topSpec.addColorStop(0.3,  'rgba(255,255,255,0.20)');
    topSpec.addColorStop(0.5,  'rgba(255,255,255,0.40)');
    topSpec.addColorStop(0.7,  'rgba(255,255,255,0.18)');
    topSpec.addColorStop(1,    'rgba(255,255,255,0)');
    g.fillStyle = topSpec;
    g.fillRect(mL, mT + 3, mW, 2);

    return c;
  }

  function renderClock() {
    var c = makeCanvas(), g = c.getContext('2d');
    var wall = renderWall();
    g.drawImage(wall, 0, 0);

    var cx = T / 2, cy = T / 2 - 1;
    var R = 11; // outer radius

    // ── Shadow behind clock on wall ──
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath(); g.arc(cx + 1.5, cy + 2, R + 2, 0, Math.PI * 2); g.fill();

    // ── Warm lamp glow on top of frame (pendant lamps above) ──
    var lampGlow = g.createRadialGradient(cx, cy - R, 0, cx, cy, R + 3);
    lampGlow.addColorStop(0, 'rgba(255,200,100,0.18)');
    lampGlow.addColorStop(0.5, 'rgba(255,180,80,0.07)');
    lampGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lampGlow;
    g.beginPath(); g.arc(cx, cy, R + 3, 0, Math.PI * 2); g.fill();

    // ── Dark wood frame (outer ring) — thicker, bolder ──
    g.fillStyle = '#2a1608';
    g.beginPath(); g.arc(cx, cy, R + 2, 0, Math.PI * 2); g.fill();
    // Frame highlight (warm top-left rim catch from lamp)
    g.strokeStyle = 'rgba(160,110,50,0.55)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(cx, cy, R + 1, -Math.PI * 0.85, -Math.PI * 0.15); g.stroke();
    // Frame inner edge (dark separation from face)
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R - 0.5, 0, Math.PI * 2); g.stroke();

    // ── Clock face (warm cream — lit by lamp) ──
    var faceGrd = g.createRadialGradient(cx - 2, cy - 3, 0, cx, cy, R);
    faceGrd.addColorStop(0, '#fff8ea');
    faceGrd.addColorStop(0.6, '#f5e8cc');
    faceGrd.addColorStop(1, '#ddd0b0');
    g.fillStyle = faceGrd;
    g.beginPath(); g.arc(cx, cy, R - 1, 0, Math.PI * 2); g.fill();

    // ── Hour markers — bold filled blocks at cardinal (12/3/6/9), solid dots elsewhere ──
    for (var h = 0; h < 12; h++) {
      var angle = (h * Math.PI * 2) / 12 - Math.PI / 2;
      var big = (h % 3 === 0);
      if (big) {
        // Bold rectangular block marker — reads clearly at phone scale
        var outerH = R - 1.8, innerH = R - 5;
        g.strokeStyle = '#1a0e04'; g.lineWidth = 2.2;
        g.lineCap = 'square';
        g.beginPath();
        g.moveTo(cx + Math.cos(angle) * innerH, cy + Math.sin(angle) * innerH);
        g.lineTo(cx + Math.cos(angle) * outerH, cy + Math.sin(angle) * outerH);
        g.stroke();
        g.lineCap = 'butt';
      } else {
        // Filled circle dots — 1px radius, visible at mobile scale
        var mr = R - 3;
        var mx = cx + Math.cos(angle) * mr;
        var my = cy + Math.sin(angle) * mr;
        g.fillStyle = '#3a2a1a';
        g.beginPath(); g.arc(mx, my, 1, 0, Math.PI * 2); g.fill();
      }
    }

    // (Clock hands drawn live by drawClockHands — no static hands here)
    // Center pin (static, under the live hands)
    g.fillStyle = '#9a7420';
    g.beginPath(); g.arc(cx, cy, 1.5, 0, Math.PI * 2); g.fill();
    // Pin warm highlight (lamp catch)
    g.fillStyle = 'rgba(255,230,140,0.5)';
    g.beginPath(); g.arc(cx - 0.4, cy - 0.4, 0.6, 0, Math.PI * 2); g.fill();

    // ── Glass dome reflection — bold arc, reads at mobile ──
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(cx - 2, cy - 3, R - 3, -Math.PI * 0.65, -Math.PI * 0.15); g.stroke();
    // Softer secondary highlight lower
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(cx - 1, cy - 1, R - 2, -Math.PI * 0.75, -Math.PI * 0.25); g.stroke();
    // Dome radial fill (warm glow center)
    var domeGrd = g.createRadialGradient(cx - 3, cy - 4, 0, cx, cy, R);
    domeGrd.addColorStop(0, 'rgba(255,255,255,0.1)');
    domeGrd.addColorStop(0.5, 'rgba(255,230,180,0.04)');
    domeGrd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = domeGrd;
    g.beginPath(); g.arc(cx, cy, R - 1, 0, Math.PI * 2); g.fill();
    // Dome edge refraction (thin bright ring on glass edge)
    g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 0.3;
    g.beginPath(); g.arc(cx, cy, R - 0.5, 0, Math.PI * 2); g.stroke();

    // ── Hanging wire/chain above clock ──
    g.strokeStyle = '#3a2210'; g.lineWidth = 0.7;
    g.beginPath(); g.moveTo(cx, cy - R - 1.5); g.lineTo(cx, 1); g.stroke();
    // Small nail/hook
    g.fillStyle = '#5a4a3a';
    g.beginPath(); g.arc(cx, 1.5, 1, 0, Math.PI * 2); g.fill();

    // ── Small pendulum weight (below clock body) ──
    g.strokeStyle = 'rgba(139,105,20,0.3)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(cx, cy + R + 1.5); g.lineTo(cx, cy + R + 4); g.stroke();
    // Pendulum disc (tiny brass)
    g.fillStyle = 'rgba(184,134,11,0.25)';
    g.beginPath(); g.arc(cx, cy + R + 4.5, 1.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,220,140,0.12)';
    g.beginPath(); g.arc(cx - 0.3, cy + R + 4.2, 0.5, 0, Math.PI * 2); g.fill();

    // dynamic hands rendered in drawTileLive
    return c;
  }

  function renderOpenSign() {
    var c = makeCanvas(), g = c.getContext('2d');
    // Wall background
    var wall = renderWall();
    g.drawImage(wall, 0, 0);

    var sx = 4, sy = 7, sw = T - 8, sh = 18;
    var cx = sx + sw / 2, cy = sy + sh / 2;

    // ── Wide neon glow on wall (bold light spill — must read at phone scale) ──
    var wallGlow = g.createRadialGradient(cx, cy, 1, cx, cy, T * 0.85);
    wallGlow.addColorStop(0,   'rgba(255,170,40,0.55)');
    wallGlow.addColorStop(0.3, 'rgba(255,130,20,0.28)');
    wallGlow.addColorStop(0.6, 'rgba(255,100,0,0.1)');
    wallGlow.addColorStop(1,   'rgba(255,80,0,0)');
    g.fillStyle = wallGlow; g.fillRect(0, 0, T, T);

    // ── Sign housing (dark box with beveled edge) ──
    // Shadow behind box
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(sx + 1, sy + 1, sw, sh);
    // Box body
    g.fillStyle = '#0a0a0a'; g.fillRect(sx, sy, sw, sh);
    // Bevel highlight (top-left)
    g.fillStyle = 'rgba(80,80,80,0.35)'; g.fillRect(sx, sy, sw, 1);
    g.fillRect(sx, sy, 1, sh);
    // Bevel shadow (bottom-right)
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(sx, sy + sh - 1, sw, 1);
    g.fillRect(sx + sw - 1, sy, 1, sh);

    // ── Inner amber fill — sign box glows from within ──
    var innerGlow = g.createRadialGradient(cx, cy, 0, cx, cy, sw * 0.65);
    innerGlow.addColorStop(0,   'rgba(255,200,80,0.40)');
    innerGlow.addColorStop(0.5, 'rgba(255,160,30,0.20)');
    innerGlow.addColorStop(1,   'rgba(255,120,0,0)');
    g.fillStyle = innerGlow; g.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);

    // ── Corner mounting screws ──
    var screwColor = 'rgba(120,100,80,0.5)', screwHi = 'rgba(180,160,130,0.3)';
    var screws = [[sx + 2, sy + 2], [sx + sw - 3, sy + 2], [sx + 2, sy + sh - 3], [sx + sw - 3, sy + sh - 3]];
    for (var si = 0; si < screws.length; si++) {
      g.fillStyle = screwColor;
      g.beginPath(); g.arc(screws[si][0], screws[si][1], 1, 0, Math.PI * 2); g.fill();
      g.fillStyle = screwHi;
      g.beginPath(); g.arc(screws[si][0] - 0.3, screws[si][1] - 0.3, 0.4, 0, Math.PI * 2); g.fill();
    }

    // ── OPEN neon tube letters — bold 4-pass glow for phone readability ──
    // lh bumped to 6.5 so letters fill the box height properly
    var ly = cy + 0.5, lh = 6.5;
    // 4-pass neon helper: halo → bloom → tube → hot-core
    function neonStroke(x1, y1, x2, y2) {
      // Pass 1: wide amber halo
      g.strokeStyle = 'rgba(255,140,20,0.55)'; g.lineWidth = 5;
      g.shadowColor = '#ff5500'; g.shadowBlur = 14;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      // Pass 2: bloom
      g.strokeStyle = 'rgba(255,170,40,0.75)'; g.lineWidth = 3;
      g.shadowColor = '#ff7700'; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      // Pass 3: orange tube
      g.strokeStyle = '#ffb020'; g.lineWidth = 2;
      g.shadowColor = '#ffaa00'; g.shadowBlur = 4;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      // Pass 4: near-white hot core
      g.strokeStyle = '#fff8d0'; g.lineWidth = 1;
      g.shadowColor = '#ffe080'; g.shadowBlur = 2;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    function neonArc(ax, ay, r, a1, a2) {
      g.strokeStyle = 'rgba(255,140,20,0.55)'; g.lineWidth = 5;
      g.shadowColor = '#ff5500'; g.shadowBlur = 14;
      g.beginPath(); g.arc(ax, ay, r, a1, a2); g.stroke();
      g.strokeStyle = 'rgba(255,170,40,0.75)'; g.lineWidth = 3;
      g.shadowColor = '#ff7700'; g.shadowBlur = 8;
      g.beginPath(); g.arc(ax, ay, r, a1, a2); g.stroke();
      g.strokeStyle = '#ffb020'; g.lineWidth = 2;
      g.shadowColor = '#ffaa00'; g.shadowBlur = 4;
      g.beginPath(); g.arc(ax, ay, r, a1, a2); g.stroke();
      g.strokeStyle = '#fff8d0'; g.lineWidth = 1;
      g.shadowColor = '#ffe080'; g.shadowBlur = 2;
      g.beginPath(); g.arc(ax, ay, r, a1, a2); g.stroke();
    }
    g.lineCap = 'round';
    // letterW + gap sized so 4 letters fill the box width with breathing room
    var letterW = 4.5, gap = 1.2;
    var startX = cx - (letterW * 4 + gap * 3) / 2;
    // O — full circle, radius bumped to match new lh
    var ox = startX + letterW / 2;
    neonArc(ox, ly, lh * 0.46, 0, Math.PI * 2);
    // P — vertical stem + right-side bump
    var px2 = startX + letterW + gap;
    neonStroke(px2, ly - lh * 0.46, px2, ly + lh * 0.46);
    neonArc(px2 + 1.3, ly - lh * 0.15, lh * 0.31, -Math.PI * 0.5, Math.PI * 0.5);
    // E — vertical + 3 horizontals
    var ex = startX + (letterW + gap) * 2;
    neonStroke(ex, ly - lh * 0.46, ex, ly + lh * 0.46);
    neonStroke(ex, ly - lh * 0.46, ex + letterW * 0.75, ly - lh * 0.46);
    neonStroke(ex, ly,              ex + letterW * 0.55, ly);
    neonStroke(ex, ly + lh * 0.46, ex + letterW * 0.75, ly + lh * 0.46);
    // N — two verticals + diagonal
    var nx = startX + (letterW + gap) * 3;
    neonStroke(nx,              ly + lh * 0.46, nx,              ly - lh * 0.46);
    neonStroke(nx,              ly - lh * 0.46, nx + letterW * 0.72, ly + lh * 0.46);
    neonStroke(nx + letterW * 0.72, ly + lh * 0.46, nx + letterW * 0.72, ly - lh * 0.46);
    g.shadowBlur = 0;

    // ── Tube connector dots — bright amber, clearly visible ──
    g.fillStyle = 'rgba(255,200,80,0.85)';
    g.shadowColor = '#ffaa00'; g.shadowBlur = 4;
    var dots = [[ox - lh * 0.46, ly], [px2, ly + lh * 0.46], [ex, ly + lh * 0.46], [nx, ly + lh * 0.46]];
    for (var di = 0; di < dots.length; di++) {
      g.beginPath(); g.arc(dots[di][0], dots[di][1], 0.8, 0, Math.PI * 2); g.fill();
    }
    g.shadowBlur = 0;

    // ── Hanging chain links (from top of box to wall) ──
    g.strokeStyle = 'rgba(100,80,60,0.4)'; g.lineWidth = 0.6;
    // Left chain — 3 tiny links
    for (var cl = 0; cl < 3; cl++) {
      var cly = sy - 1 - cl * 1.5;
      g.beginPath(); g.ellipse(cx - 5, cly, 0.8, 0.6, 0, 0, Math.PI * 2); g.stroke();
    }
    // Right chain
    for (var cr = 0; cr < 3; cr++) {
      var cry = sy - 1 - cr * 1.5;
      g.beginPath(); g.ellipse(cx + 5, cry, 0.8, 0.6, 0, 0, Math.PI * 2); g.stroke();
    }

    // ── Power cord (thin wire from bottom-right of box down to floor) ──
    g.strokeStyle = 'rgba(40,40,40,0.35)'; g.lineWidth = 0.5;
    g.beginPath();
    g.moveTo(sx + sw - 2, sy + sh);
    g.quadraticCurveTo(sx + sw + 1, sy + sh + 4, sx + sw - 1, T);
    g.stroke();

    // ── Warm amber light puddle on floor below sign ──
    var floorGlow = g.createRadialGradient(cx, T - 1, 0, cx, T - 1, 13);
    floorGlow.addColorStop(0,   'rgba(255,170,40,0.28)');
    floorGlow.addColorStop(0.5, 'rgba(255,140,20,0.12)');
    floorGlow.addColorStop(1,   'rgba(255,110,0,0)');
    g.fillStyle = floorGlow; g.fillRect(0, T - 10, T, 10);

    return c;
  }

  function renderCoatRack() {
    var c = makeCanvas(), g = c.getContext('2d');
    // Wall background
    var wall = renderWall();
    g.drawImage(wall, 0, 0);
    var cx = T / 2;

    // ── Tripod base (3 feet splayed out) ──
    g.strokeStyle = '#4a3020'; g.lineWidth = 1.5;
    // Left foot
    g.beginPath(); g.moveTo(cx, T - 6); g.lineTo(cx - 8, T - 2); g.stroke();
    // Right foot
    g.beginPath(); g.moveTo(cx, T - 6); g.lineTo(cx + 8, T - 2); g.stroke();
    // Center foot (forward, shorter — perspective)
    g.beginPath(); g.moveTo(cx, T - 6); g.lineTo(cx, T - 2); g.stroke();
    // Foot tips (rubber caps)
    g.fillStyle = '#2a1a10';
    g.fillRect(cx - 9, T - 3, 2, 2);
    g.fillRect(cx + 7, T - 3, 2, 2);
    g.fillRect(cx - 1, T - 3, 2, 2);

    // ── Main pole (turned wood, tapered) ──
    // Shadow side
    g.fillStyle = '#3d2818'; g.fillRect(cx, 5, 2, T - 11);
    // Light side
    g.fillStyle = '#5d3d28'; g.fillRect(cx - 1, 5, 2, T - 11);
    // Highlight stripe
    g.fillStyle = 'rgba(180,140,100,0.15)'; g.fillRect(cx - 1, 5, 1, T - 11);
    // Decorative turned rings
    g.fillStyle = '#4a3020';
    g.fillRect(cx - 2, T - 8, 5, 1.5);
    g.fillRect(cx - 2, 7, 5, 1.5);

    // ── Top finial (rounded knob) ──
    g.fillStyle = '#5d3d28';
    g.beginPath(); g.arc(cx, 5, 2.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(180,140,100,0.2)';
    g.beginPath(); g.arc(cx - 0.5, 4.5, 1, 0, Math.PI * 2); g.fill();

    // ── Hooks (curved brass — 3-pass for warm metal glow) ──
    var hooks = [
      { x: cx - 7, y: 10, dir: -1 },
      { x: cx + 7, y: 10, dir: 1 },
      { x: cx - 6, y: 18, dir: -1 },
      { x: cx + 6, y: 18, dir: 1 },
    ];
    function brassHook(x1, y1, cpx, cpy, x2, y2, tipX, tipY, tipR, tipCCW) {
      // Pass 1: warm glow
      g.strokeStyle = 'rgba(180,130,50,0.35)'; g.lineWidth = 3;
      g.shadowColor = '#c89020'; g.shadowBlur = 4;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cpx, cpy, x2, y2); g.stroke();
      g.beginPath(); g.arc(tipX, tipY, tipR, 0, Math.PI, tipCCW); g.stroke();
      // Pass 2: solid brass
      g.strokeStyle = '#c8a840'; g.lineWidth = 1.4;
      g.shadowColor = '#d4b840'; g.shadowBlur = 2;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cpx, cpy, x2, y2); g.stroke();
      g.beginPath(); g.arc(tipX, tipY, tipR, 0, Math.PI, tipCCW); g.stroke();
      // Pass 3: bright specular
      g.strokeStyle = '#f0d870'; g.lineWidth = 0.5;
      g.shadowBlur = 0;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cpx, cpy, x2, y2); g.stroke();
    }
    g.lineCap = 'round';
    for (var hi = 0; hi < hooks.length; hi++) {
      var h = hooks[hi];
      brassHook(
        cx + h.dir * 1, h.y,
        h.x, h.y - 1, h.x, h.y + 2,
        h.x, h.y + 1.5, 1, h.dir > 0
      );
    }
    g.shadowBlur = 0;

    // ── Hanging coat (left hook — dark olive trench) ──
    // Base: slightly lighter so shadows read against it
    g.fillStyle = '#4a5c3a';
    g.fillRect(cx - 10, 11, 6, 10);
    // Main fold crease (deep shadow, clearly visible)
    g.fillStyle = 'rgba(0,0,0,0.40)';
    g.fillRect(cx - 8, 13, 1.5, 7);
    // Second fold (medium shadow)
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(cx - 6, 14, 1, 6);
    // Left edge highlight (light catching front face)
    g.fillStyle = 'rgba(140,170,110,0.20)';
    g.fillRect(cx - 10, 12, 1.5, 8);
    // Collar (distinctly lighter — turned-up lapels catch overhead light)
    g.fillStyle = '#6a7a55';
    g.fillRect(cx - 10, 11, 6, 2);
    // Collar lapel fold (dark inner shadow)
    g.fillStyle = '#3a4a2a';
    g.fillRect(cx - 10, 11, 2, 3);
    g.fillRect(cx - 5.5, 11, 1.5, 2.5);
    // Collar top-edge highlight
    g.fillStyle = 'rgba(160,190,130,0.30)';
    g.fillRect(cx - 10, 11, 6, 0.7);
    // Two buttons (bright brass — must pop at phone scale)
    g.fillStyle = '#c8a840';
    g.beginPath(); g.arc(cx - 7, 15, 0.8, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx - 7, 17.5, 0.8, 0, Math.PI * 2); g.fill();
    // Button specular
    g.fillStyle = 'rgba(255,240,160,0.45)';
    g.beginPath(); g.arc(cx - 7.25, 14.75, 0.3, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx - 7.25, 17.25, 0.3, 0, Math.PI * 2); g.fill();
    // Belt (dark, clearly contrasting band)
    g.fillStyle = '#1e2a18';
    g.fillRect(cx - 10, 17, 6, 1.2);
    // Belt buckle (bright brass)
    g.fillStyle = '#c8a840';
    g.fillRect(cx - 8.8, 16.8, 1.8, 1.5);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(cx - 8.4, 17.1, 0.8, 0.9);
    // Buckle gleam
    g.fillStyle = 'rgba(255,230,130,0.4)';
    g.fillRect(cx - 8.8, 16.8, 1.8, 0.4);
    // Pocket flap (visible dark line)
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(cx - 9.5, 18.5, 3.5, 0.7);
    // Coat hem (wider, slightly lighter — hangs forward)
    g.fillStyle = '#566845';
    g.fillRect(cx - 10, 20, 6, 1.2);
    g.fillStyle = 'rgba(0,0,0,0.20)';
    g.fillRect(cx - 10, 20.8, 6, 0.5);

    // ── Hanging scarf (right hook — tartan plaid) ──
    // Base: brighter burgundy so navy reads against it
    g.fillStyle = '#8a2828';
    g.fillRect(cx + 5, 11, 3, 12);
    // Tartan horizontal stripes — fully opaque colors, not translucent
    g.fillStyle = '#1e2c5a'; // solid navy blue
    g.fillRect(cx + 5, 13, 3, 1.2);
    g.fillRect(cx + 5, 17, 3, 1.2);
    g.fillRect(cx + 5, 21, 3, 1.2);
    g.fillStyle = '#c8a830'; // solid gold line
    g.fillRect(cx + 5, 15, 3, 0.7);
    g.fillRect(cx + 5, 19, 3, 0.7);
    // Tartan vertical stripe (center — solid navy)
    g.fillStyle = '#1e2c5a';
    g.fillRect(cx + 6, 11, 1, 12);
    // Thin gold vertical
    g.fillStyle = '#c8a830';
    g.fillRect(cx + 5.3, 11, 0.5, 12);
    // Fabric fold shadow (strong crease — visible at small scale)
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(cx + 7, 13, 0.8, 8);
    // Left-edge light
    g.fillStyle = 'rgba(200,130,130,0.20)';
    g.fillRect(cx + 5, 11, 0.7, 12);
    // Scarf end (draped, wider)
    g.fillStyle = '#9a3030';
    g.fillRect(cx + 4, 21, 5, 3);
    g.fillStyle = '#1e2c5a';
    g.fillRect(cx + 4, 22, 5, 1);
    g.fillStyle = '#c8a830';
    g.fillRect(cx + 6, 21, 0.7, 3);
    // Fringe (chunky enough to see at 32px)
    g.fillStyle = '#b84040';
    g.fillRect(cx + 4, 24, 1.2, 2.5);
    g.fillRect(cx + 5.8, 24, 1.2, 2);
    g.fillRect(cx + 7.2, 24, 1.2, 2.5);
    g.fillRect(cx + 8.2, 24, 1, 1.5);

    // ── Umbrella (leaning against base, closed with fabric folds) ──
    var ubx1 = cx + 4, uby1 = T - 3; // bottom tip
    var ubx2 = cx + 2, uby2 = T - 14; // top near handle
    // Closed canopy (tapered cone of folded fabric)
    // Main shaft (dark navy)
    g.strokeStyle = '#1a1a3a'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(ubx1, uby1); g.lineTo(ubx2, uby2); g.stroke();
    // Fabric folds (slightly wider, draped around shaft)
    g.fillStyle = '#1e1e40';
    g.beginPath();
    g.moveTo(ubx1 - 0.5, uby1 - 1);
    g.lineTo(ubx2 - 1.5, uby2 + 2);
    g.lineTo(ubx2 + 1.5, uby2 + 2);
    g.lineTo(ubx1 + 1, uby1 - 1);
    g.closePath(); g.fill();
    // Fold creases (lighter ridges where fabric bunches)
    g.strokeStyle = 'rgba(50,50,90,0.25)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(ubx1 + 0.3, uby1 - 2); g.lineTo(ubx2 + 0.5, uby2 + 3); g.stroke();
    g.beginPath(); g.moveTo(ubx1 - 0.2, uby1 - 3); g.lineTo(ubx2 - 0.8, uby2 + 3); g.stroke();
    // Fabric highlight (light catches one ridge)
    g.strokeStyle = 'rgba(80,80,130,0.12)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(ubx1 - 0.3, uby1 - 1); g.lineTo(ubx2 - 1, uby2 + 2); g.stroke();
    // Velcro/snap strap (keeps umbrella closed)
    g.fillStyle = 'rgba(40,40,70,0.4)';
    g.fillRect(ubx2 + 0.5, uby2 + 5, 2, 0.8);
    g.fillStyle = 'rgba(140,140,160,0.2)'; // snap dot
    g.beginPath(); g.arc(ubx2 + 1.5, uby2 + 5.4, 0.3, 0, Math.PI * 2); g.fill();
    // Ferrule tip (metal point at bottom)
    g.fillStyle = '#8a8a9a';
    g.fillRect(ubx1 - 0.3, uby1 - 0.5, 1, 1.5);
    g.fillStyle = 'rgba(200,200,220,0.2)';
    g.fillRect(ubx1 - 0.3, uby1 - 0.5, 1, 0.3); // tip shine
    // Handle (curved bamboo/wood J-hook)
    g.strokeStyle = '#6b4226'; g.lineWidth = 1.4;
    g.beginPath();
    g.arc(cx + 3, T - 14, 2, Math.PI * 0.5, Math.PI * 1.5);
    g.stroke();
    // Handle highlight (wood sheen)
    g.strokeStyle = 'rgba(160,120,70,0.2)'; g.lineWidth = 0.4;
    g.beginPath();
    g.arc(cx + 3, T - 14, 1.6, Math.PI * 0.7, Math.PI * 1.3);
    g.stroke();
    // Handle tip (slightly wider knob)
    g.fillStyle = '#5a3218';
    g.beginPath(); g.arc(cx + 3, T - 12, 0.8, 0, Math.PI * 2); g.fill();

    // ── Fedora hat (perched on top finial) ──
    // Brim shadow (cast on pole below)
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.beginPath(); g.ellipse(cx, 6.5, 4.5, 1.5, 0, 0, Math.PI * 2); g.fill();
    // Hat brim — noticeably lighter than crown for silhouette contrast
    g.fillStyle = '#5a4a38';
    g.beginPath(); g.ellipse(cx + 1, 4.5, 5, 2, -0.15, 0, Math.PI * 2); g.fill();
    // Brim top-edge highlight (overhead light)
    g.fillStyle = 'rgba(200,175,140,0.25)';
    g.beginPath(); g.ellipse(cx + 1, 4.3, 4.5, 1.6, -0.15, Math.PI, 0); g.fill();
    // Brim underside shadow (dark crescent)
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(cx + 1, 5, 4.5, 1.5, -0.15, 0, Math.PI); g.fill();
    // Hat crown — distinctly darker than brim
    g.fillStyle = '#3a2d22';
    g.fillRect(cx - 2, 1, 6, 4);
    // Crown top (rounded cap)
    g.beginPath(); g.ellipse(cx + 1, 1.5, 3, 1.5, 0, Math.PI, 0); g.fill();
    // Crown pinch dent
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(cx - 0.5, 0.5, 2, 1.5);
    // Felt texture lines
    g.strokeStyle = 'rgba(90,70,50,0.20)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(cx - 1, 1.2); g.lineTo(cx + 2, 3.8); g.stroke();
    g.beginPath(); g.moveTo(cx + 0.5, 1.2); g.lineTo(cx + 3, 3.8); g.stroke();
    // Crown top highlight
    g.fillStyle = 'rgba(160,140,110,0.22)';
    g.fillRect(cx - 1, 1.5, 3, 1);
    // Crown side gleam
    g.fillStyle = 'rgba(140,115,85,0.18)';
    g.fillRect(cx + 2.5, 2, 0.8, 2);
    // Hat band — nearly black, strong contrast against crown
    g.fillStyle = '#1a1008';
    g.fillRect(cx - 2, 3.5, 6, 1.4);
    // Band silk sheen
    g.fillStyle = 'rgba(130,100,60,0.30)';
    g.fillRect(cx - 2, 3.5, 6, 0.4);
    // Band buckle — bright silver to catch the eye
    g.fillStyle = '#b0b0c0';
    g.fillRect(cx + 2.5, 3.6, 1.2, 1.0);
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(cx + 2.8, 3.8, 0.6, 0.6);
    g.fillStyle = 'rgba(240,240,255,0.40)';
    g.fillRect(cx + 2.5, 3.6, 1.2, 0.3);
    // Feather accent (warmer, more visible)
    g.strokeStyle = 'rgba(160,130,70,0.55)'; g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(cx + 3, 3.5);
    g.quadraticCurveTo(cx + 5.5, 2, cx + 6, 0.5);
    g.stroke();
    // Feather barbs
    g.strokeStyle = 'rgba(140,110,60,0.35)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(cx + 4.5, 2); g.lineTo(cx + 5.3, 1.5); g.stroke();
    g.beginPath(); g.moveTo(cx + 5, 1.5); g.lineTo(cx + 5.8, 0.8); g.stroke();

    // ── Canvas tote bag (lower left hook) ──
    g.fillStyle = '#d4b88a'; // warm natural canvas, bright enough to read
    g.fillRect(cx - 9, 19, 5, 7);
    // Canvas weave — stronger lines, visible at 32px
    g.strokeStyle = 'rgba(120,95,60,0.22)'; g.lineWidth = 0.5;
    for (var tw = 0; tw < 6; tw++) {
      g.beginPath(); g.moveTo(cx - 9, 20.5 + tw); g.lineTo(cx - 4, 20.5 + tw); g.stroke();
    }
    // Left edge highlight
    g.fillStyle = 'rgba(255,235,195,0.20)';
    g.fillRect(cx - 9, 19, 1, 7);
    // Bag opening (clearly darker interior)
    g.fillStyle = '#6a5030';
    g.fillRect(cx - 9, 19, 5, 1.4);
    // Book spine peeking out — bold colors visible over canvas
    g.fillStyle = '#9a2020'; // red book
    g.fillRect(cx - 8.5, 19, 1.8, 1.0);
    g.fillStyle = '#1e4a7a'; // blue notebook
    g.fillRect(cx - 6.4, 19, 1.2, 0.8);
    // Handle straps — thicker, warm brown
    g.strokeStyle = '#8a6840'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(cx - 8, 19); g.lineTo(cx - 7, 17); g.stroke();
    g.beginPath(); g.moveTo(cx - 5, 19); g.lineTo(cx - 5, 17); g.stroke();
    // Strap highlight
    g.strokeStyle = 'rgba(200,175,130,0.30)'; g.lineWidth = 0.5;
    g.beginPath(); g.moveTo(cx - 8, 18.9); g.lineTo(cx - 7, 17); g.stroke();
    // Bag fold shadow (strong visible crease)
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(cx - 7, 21, 1.2, 4);
    // Second fold
    g.fillStyle = 'rgba(0,0,0,0.14)';
    g.fillRect(cx - 5.2, 22, 0.8, 3);
    // Printed stamp logo (more visible)
    g.strokeStyle = 'rgba(100,70,35,0.35)'; g.lineWidth = 0.5;
    g.beginPath(); g.arc(cx - 6.5, 23, 1.5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(100,70,35,0.18)';
    g.fillRect(cx - 7.5, 22.8, 2, 0.5);
    // Bottom sag (wider, warmer)
    g.fillStyle = '#c8aa7a';
    g.fillRect(cx - 9.5, 25, 6, 1.2);
    g.fillStyle = 'rgba(0,0,0,0.20)';
    g.fillRect(cx - 9.5, 25.8, 6, 0.5);

    // ── Shadow on wall behind rack ──
    var rackShadow = g.createLinearGradient(cx + 1, 0, cx + 8, 0);
    rackShadow.addColorStop(0, 'rgba(0,0,0,0.22)');
    rackShadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rackShadow;
    g.fillRect(cx + 1, 4, 8, T - 6);

    return c;
  }

  function renderCruzPos() {
    var c = makeCanvas(), g = c.getContext('2d');
    var counter = renderCounter();
    g.drawImage(counter, 0, 0);

    // ── Laptop (open, slightly angled) ──
    var lx = 4, ly = 6;
    // Screen (dark with faint code glow)
    g.fillStyle = '#1a1a2e'; g.fillRect(lx, ly, 12, 8);
    // Screen bezel
    g.strokeStyle = '#333'; g.lineWidth = 0.5;
    g.strokeRect(lx, ly, 12, 8);
    // Code lines (faint green/blue glow)
    g.fillStyle = 'rgba(80,200,120,0.25)';
    g.fillRect(lx + 2, ly + 2, 5, 1);
    g.fillRect(lx + 2, ly + 4, 7, 1);
    g.fillStyle = 'rgba(100,160,255,0.2)';
    g.fillRect(lx + 3, ly + 6, 4, 1);
    // Screen glow on counter
    var screenGlow = g.createRadialGradient(lx + 6, ly + 4, 0, lx + 6, ly + 4, 10);
    screenGlow.addColorStop(0, 'rgba(80,200,120,0.04)');
    screenGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = screenGlow; g.fillRect(0, 0, T, T);
    // Keyboard base
    g.fillStyle = '#2a2a2a'; g.fillRect(lx, ly + 8, 12, 3);
    g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(lx + 1, ly + 9, 10, 1);

    // ── Coffee mug (Cruz's personal cup) ──
    var mugX = 20, mugY = 8;
    // Mug body (dark ceramic)
    g.fillStyle = '#2a2018'; g.fillRect(mugX, mugY, 5, 5);
    // Coffee inside (with steam)
    g.fillStyle = '#3a2210'; g.fillRect(mugX + 0.5, mugY + 0.5, 4, 2);
    // Mug handle
    g.strokeStyle = '#2a2018'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(mugX + 6, mugY + 2.5, 2, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
    // Steam curl — visible wisps over dark mug
    g.strokeStyle = 'rgba(210,195,175,0.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(mugX + 2, mugY - 1);
    g.quadraticCurveTo(mugX + 1, mugY - 3, mugX + 3, mugY - 4); g.stroke();
    // Second wisp (offset for volume)
    g.strokeStyle = 'rgba(210,195,175,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(mugX + 4, mugY - 0.5);
    g.quadraticCurveTo(mugX + 5, mugY - 2.5, mugX + 3.5, mugY - 3.5); g.stroke();

    // ── Small notebook (Moleskine-style, closed) ──
    g.fillStyle = '#1a1a1a'; g.fillRect(19, 17, 8, 10);
    // Elastic band — solid 1px, clearly visible
    g.strokeStyle = '#c8a040'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(23, 17); g.lineTo(23, 27); g.stroke();
    // Page edges (cream stripe)
    g.fillStyle = '#f0e8d0'; g.fillRect(27, 18, 1, 8);
    // Corner wear (notebook used daily) — subtle but readable
    g.fillStyle = 'rgba(60,50,40,0.35)';
    g.fillRect(19, 26, 2, 1); g.fillRect(25, 17, 2, 1);

    // ── Pen (resting diagonally on notebook) ──
    g.save();
    g.translate(22, 20);
    g.rotate(-0.35);
    // Pen body (dark blue)
    g.fillStyle = '#1a2a4a';
    g.fillRect(-1, 0, 10, 1.2);
    // Pen clip (gold, thin)
    g.fillStyle = '#b8960b';
    g.fillRect(0, -0.3, 3, 0.4);
    // Pen tip
    g.fillStyle = '#c0c0c0';
    g.fillRect(9, 0.2, 1.5, 0.8);
    g.fillStyle = '#333';
    g.fillRect(10.2, 0.3, 0.5, 0.6);
    g.restore();

    // ── Sticky note (small yellow, with peeling corner curl) ──
    g.save();
    g.translate(17, 22);
    g.rotate(0.08);
    g.fillStyle = '#f5e87a';
    g.fillRect(0, 0, 5, 4);
    // Adhesive strip (slightly darker at top) — readable tint
    g.fillStyle = 'rgba(200,180,80,0.35)';
    g.fillRect(0, 0, 5, 0.6);
    // Peeling corner curl (bottom-right lifts up)
    g.fillStyle = 'rgba(0,0,0,0.25)'; // shadow under curl — visible
    g.beginPath();
    g.moveTo(3, 4); g.lineTo(5, 4); g.lineTo(5, 2.5); g.closePath(); g.fill();
    g.fillStyle = '#ede070'; // curled paper (slightly darker, underside)
    g.beginPath();
    g.moveTo(3.5, 4); g.lineTo(5, 4); g.lineTo(5, 3); g.closePath(); g.fill();
    // Tiny handwriting (blue ink, Cruz's notes) — use 1px-tall rects for crisp lines
    g.fillStyle = 'rgba(30,40,80,0.6)';
    g.fillRect(0.5, 1, 3.5, 1);
    g.fillRect(0.5, 2.2, 2.5, 1);
    g.fillRect(0.5, 3.2, 1.5, 1);
    // Checkmark (tiny, green) — solid 1px line
    g.strokeStyle = 'rgba(40,120,50,0.7)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(3.5, 1.5); g.lineTo(3.8, 1.9); g.lineTo(4.3, 1.2); g.stroke();
    g.restore();

    // ── Small plant/succulent (echeveria rosette, in corner) ──
    var plX = 2, plY = 20;
    // Tiny pot (ceramic with glaze)
    g.fillStyle = '#8a5a3a';
    g.fillRect(plX, plY + 2, 3, 2);
    g.fillStyle = '#9a6a45';
    g.fillRect(plX - 0.3, plY + 2, 3.6, 0.6); // rim
    g.fillStyle = 'rgba(255,200,150,0.35)'; // glaze highlight — visible ceramic sheen
    g.fillRect(plX, plY + 2, 3, 0.5);
    // Soil
    g.fillStyle = '#3a2a1a';
    g.fillRect(plX + 0.3, plY + 2, 2.4, 0.4);
    // Succulent rosette (top-down, layered petals)
    // Outer petals (6 tiny ellipses radiating)
    g.fillStyle = '#4a8a55';
    for (var pi = 0; pi < 6; pi++) {
      var pa = (pi / 6) * Math.PI * 2;
      g.beginPath();
      g.ellipse(plX + 1.5 + Math.cos(pa) * 1, plY + 1 + Math.sin(pa) * 0.8, 0.7, 0.4, pa, 0, Math.PI * 2);
      g.fill();
    }
    // Middle ring
    g.fillStyle = '#5aa565';
    g.beginPath(); g.arc(plX + 1.5, plY + 1, 0.8, 0, Math.PI * 2); g.fill();
    // Center bud
    g.fillStyle = '#6ab575';
    g.beginPath(); g.arc(plX + 1.5, plY + 1, 0.3, 0, Math.PI * 2); g.fill();

    // ── USB cable (trailing from laptop, with connector) ──
    g.strokeStyle = 'rgba(40,40,40,0.7)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(16, 12);
    g.quadraticCurveTo(18, 14, 17, 16);
    g.quadraticCurveTo(16, 18, 18, 19);
    g.stroke();
    // USB-C connector (clearly visible silver rectangle)
    g.fillStyle = 'rgba(180,180,180,0.75)';
    g.fillRect(15.5, 11.5, 1.5, 1);
    // Cable end (loose tail — same weight as main cable)
    g.strokeStyle = 'rgba(40,40,40,0.5)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(18, 19);
    g.quadraticCurveTo(19, 20, 18.5, 20.5);
    g.stroke();

    return c;
  }

  // ── Bar back shelf — wall-mounted shelves with bottles & glasses ──
  // Variant index changes bottle layout so tiling isn't obvious
  function renderBarShelf(variant) {
    var c = makeCanvas(), g = c.getContext('2d');
    var v = variant || 0;

    // ── Brick wall base (same palette as renderWall) ──
    g.fillStyle = '#2a1c15'; g.fillRect(0, 0, T, T);
    var brickColors = ['#4a3020', '#3d2820', '#45302a', '#503828'];
    var brickH = 8, brickW = 16;
    for (var row = 0; row < T; row += brickH) {
      var off = ((row / brickH) % 2) * (brickW / 2);
      for (var col = -brickW + off; col < T + brickW; col += brickW) {
        var seed = Math.abs(row * 7 + col * 13 + v * 31);
        g.fillStyle = brickColors[seed % brickColors.length];
        g.fillRect(col + 1, row + 1, brickW - 2, brickH - 2);
        g.fillStyle = 'rgba(255,200,140,0.05)';
        g.fillRect(col + 1, row + 1, brickW - 2, 1);
        g.fillStyle = 'rgba(0,0,0,0.08)';
        g.fillRect(col + 1, row + brickH - 2, brickW - 2, 1);
      }
    }

    // ── Two wooden shelves (upper at y=6, lower at y=20) ──
    var shelfYs = [6, 20];
    for (var si = 0; si < 2; si++) {
      var sy = shelfYs[si];
      // Shelf bracket shadows
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(4, sy + 1, 2, 4); g.fillRect(26, sy + 1, 2, 4);
      // Bracket metal
      g.fillStyle = '#5a4a3a';
      g.fillRect(4, sy + 1, 1.5, 3); g.fillRect(27, sy + 1, 1.5, 3);
      g.fillStyle = 'rgba(180,150,100,0.15)';
      g.fillRect(4, sy + 1, 1.5, 0.5); g.fillRect(27, sy + 1, 1.5, 0.5);
      // Shelf board
      g.fillStyle = '#6b4c38'; g.fillRect(2, sy, 28, 2);
      // Top surface highlight
      g.fillStyle = 'rgba(200,160,100,0.18)'; g.fillRect(2, sy, 28, 0.7);
      // Front edge shadow
      g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(2, sy + 1.5, 28, 0.5);
      // Wood grain on shelf face
      g.strokeStyle = 'rgba(100,70,40,0.1)'; g.lineWidth = 0.3;
      g.beginPath(); g.moveTo(3, sy + 1); g.lineTo(29, sy + 1); g.stroke();
    }

    // ── Bottles on upper shelf (3 bottles, layout varies by variant) ──
    var bottleLayouts = [
      [{x:7, h:10, c:'#2d4a3a', label:'#c8a060'}, {x:14, h:12, c:'#4a2d1e', label:'#e8d0a0'}, {x:22, h:9, c:'#3a3a4a', label:'#d0b878'}],
      [{x:6, h:11, c:'#4a3828', label:'#d8c090'}, {x:15, h:10, c:'#2a3a2a', label:'#b8d080'}, {x:24, h:8, c:'#5a3020', label:'#e0c070'}],
      [{x:8, h:9, c:'#3a2840', label:'#c0a0d0'}, {x:16, h:12, c:'#4a3020', label:'#d0b070'}, {x:21, h:10, c:'#2a4a3a', label:'#a8d0a0'}],
    ];
    var bottles = bottleLayouts[v % 3];
    for (var bi = 0; bi < bottles.length; bi++) {
      var b = bottles[bi];
      var bx = b.x, by = shelfYs[0] - b.h, bh = b.h;
      // Bottle body
      g.fillStyle = b.c;
      g.fillRect(bx, by + 2, 4, bh - 2);
      // Bottle neck (narrower)
      g.fillStyle = b.c;
      g.fillRect(bx + 1, by, 2, 3);
      // Cap/cork
      g.fillStyle = '#8a7a60'; g.fillRect(bx + 1, by - 1, 2, 1.5);
      // Label (small rectangle on body)
      g.fillStyle = b.label; g.fillRect(bx + 0.5, by + 4, 3, 3);
      g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(bx + 0.5, by + 5.5, 3, 0.5);
      // Glass highlight (vertical glint on bottle)
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(bx + 3, by + 2, 0.7, bh - 4);
      // Warm light glint (reflected from overhead pendant)
      g.fillStyle = 'rgba(255,200,120,0.15)'; g.fillRect(bx + 0.5, by + 3, 0.5, 2);
    }

    // ── Glasses on lower shelf (variant-dependent arrangement) ──
    var glassLayouts = [
      [{x:7, type:'wine'}, {x:11, type:'rocks'}, {x:16, type:'wine'}, {x:21, type:'shot'}, {x:24, type:'rocks'}],
      [{x:6, type:'rocks'}, {x:10, type:'shot'}, {x:14, type:'wine'}, {x:19, type:'rocks'}, {x:23, type:'wine'}],
      [{x:8, type:'shot'}, {x:12, type:'wine'}, {x:17, type:'rocks'}, {x:22, type:'wine'}, {x:26, type:'shot'}],
    ];
    var glasses = glassLayouts[v % 3];
    for (var gi = 0; gi < glasses.length; gi++) {
      var gl = glasses[gi], gx = gl.x, gy = shelfYs[1];
      if (gl.type === 'wine') {
        // Wine glass — stem + bowl
        g.fillStyle = 'rgba(220,230,240,0.18)';
        g.fillRect(gx + 1, gy - 6, 1, 3); // stem
        g.fillRect(gx, gy - 3, 3, 0.5); // base
        // Bowl (wider)
        g.beginPath();
        g.moveTo(gx - 0.5, gy - 6);
        g.quadraticCurveTo(gx + 1.5, gy - 9, gx + 3.5, gy - 6);
        g.closePath();
        g.fillStyle = 'rgba(220,230,240,0.12)'; g.fill();
        // Rim highlight
        g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(gx - 0.5, gy - 8.5, 4, 0.4);
      } else if (gl.type === 'rocks') {
        // Short tumbler
        g.fillStyle = 'rgba(200,215,225,0.14)';
        g.fillRect(gx, gy - 4, 3, 4);
        // Rim glint
        g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(gx, gy - 4, 3, 0.4);
        // Bottom thickness
        g.fillStyle = 'rgba(180,195,210,0.1)'; g.fillRect(gx, gy - 1, 3, 0.7);
      } else {
        // Shot glass
        g.fillStyle = 'rgba(210,220,235,0.15)';
        g.fillRect(gx, gy - 3, 2, 3);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(gx, gy - 3, 2, 0.3);
      }
      // Warm ambient glow on each glass (reflected light)
      var glassGlow = g.createRadialGradient(gx + 1.5, gy - 3, 0, gx + 1.5, gy - 3, 4);
      glassGlow.addColorStop(0, 'rgba(255,200,120,0.06)');
      glassGlow.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = glassGlow; g.fillRect(gx - 3, gy - 7, 9, 8);
    }

    // ── Overhead light wash (warm pendant glow from above) ──
    var topGlow = g.createLinearGradient(0, 0, 0, T);
    topGlow.addColorStop(0, 'rgba(255,200,120,0.08)');
    topGlow.addColorStop(0.4, 'rgba(255,180,100,0.03)');
    topGlow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = topGlow; g.fillRect(0, 0, T, T);

    return c;
  }

  // ── Starry Night (Van Gogh) — 64×32 wall painting, stored as L/R halves ──
  // Tile 27 = left 32px, Tile 28 = right 32px
  function renderStarryNight() {
    var W = 64, H = 32;
    var full = makeCanvas(W, H), g = full.getContext('2d');

    // ── Gold wood frame (2px border) ──
    g.fillStyle = '#6b4c1a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c8a04a';
    g.fillRect(0, 0, W, 2);    // top
    g.fillRect(0, H - 2, W, 2); // bottom
    g.fillRect(0, 0, 2, H);    // left
    g.fillRect(W - 2, 0, 2, H); // right
    // Inner frame bevel
    g.fillStyle = '#a07828';
    g.fillRect(2, 2, W - 4, 1);
    g.fillRect(2, H - 3, W - 4, 1);
    g.fillRect(2, 2, 1, H - 4);
    g.fillRect(W - 3, 2, 1, H - 4);

    // ── Canvas inset (2px frame = 4px total from edge) ──
    var cx = 3, cy = 3, cw = W - 6, ch = H - 6;

    // ── Deep blue night sky (dominant) ──
    var skyGrd = g.createLinearGradient(cx, cy, cx, cy + ch * 0.7);
    skyGrd.addColorStop(0, '#0a1a3a');
    skyGrd.addColorStop(0.5, '#0d2248');
    skyGrd.addColorStop(1, '#1a3a5a');
    g.fillStyle = skyGrd; g.fillRect(cx, cy, cw, ch);

    // ── Van Gogh swirling sky — concentric arc strokes in deep blues & cyans ──
    var swirls = [
      { x: 12, y: 8,  r: 7,  c: '#1a4a7a', lw: 2.5 },
      { x: 26, y: 6,  r: 6,  c: '#1e5a8a', lw: 2 },
      { x: 40, y: 9,  r: 8,  c: '#16406a', lw: 2.5 },
      { x: 52, y: 7,  r: 5,  c: '#204870', lw: 1.5 },
      { x: 18, y: 13, r: 5,  c: '#0e3060', lw: 1.5 },
      { x: 34, y: 11, r: 9,  c: '#183870', lw: 2 },
      { x: 50, y: 12, r: 6,  c: '#1a4880', lw: 1.5 },
    ];
    for (var si = 0; si < swirls.length; si++) {
      var sw = swirls[si];
      g.strokeStyle = sw.c; g.lineWidth = sw.lw;
      g.beginPath();
      g.arc(sw.x, sw.y, sw.r, 0, Math.PI * 1.3);
      g.stroke();
      // Second swirl arc offset for depth
      g.lineWidth = sw.lw * 0.6;
      g.beginPath();
      g.arc(sw.x + 2, sw.y + 1, sw.r * 0.7, Math.PI * 0.2, Math.PI * 1.5);
      g.stroke();
    }

    // ── Yellow spiral stars — the signature Van Gogh element ──
    var stars = [
      { x: 10, y: 7,  r: 3, bright: true },
      { x: 25, y: 5,  r: 2.5, bright: true },
      { x: 38, y: 8,  r: 3.5, bright: true },   // moon / brightest star
      { x: 52, y: 6,  r: 2 },
      { x: 17, y: 10, r: 1.5 },
      { x: 44, y: 11, r: 1.5 },
      { x: 57, y: 10, r: 1.5 },
      { x: 6,  y: 14, r: 1 },
      { x: 31, y: 12, r: 2 },
    ];
    for (var sti = 0; sti < stars.length; sti++) {
      var st = stars[sti];
      // Radiant glow halo
      var starGrd = g.createRadialGradient(st.x, st.y, 0, st.x, st.y, st.r * 2.5);
      starGrd.addColorStop(0, st.bright ? 'rgba(255,230,80,0.9)' : 'rgba(255,220,100,0.7)');
      starGrd.addColorStop(0.4, st.bright ? 'rgba(220,190,40,0.5)' : 'rgba(200,170,40,0.3)');
      starGrd.addColorStop(1, 'rgba(255,220,0,0)');
      g.fillStyle = starGrd;
      g.beginPath(); g.arc(st.x, st.y, st.r * 2.5, 0, Math.PI * 2); g.fill();
      // Core star dot
      g.fillStyle = st.bright ? '#ffe040' : '#ffd060';
      g.beginPath(); g.arc(st.x, st.y, st.r, 0, Math.PI * 2); g.fill();
      // Inner white hotspot
      g.fillStyle = 'rgba(255,255,200,0.8)';
      g.beginPath(); g.arc(st.x, st.y, st.r * 0.4, 0, Math.PI * 2); g.fill();
    }

    // ── Dark cypress tree (left side, landmark silhouette) ──
    g.fillStyle = '#0a1205';
    // Tree trunk base
    g.fillRect(cx + 2, cy + ch - 8, 5, 8);
    // Tree body — series of dark triangular layers
    var layers = [
      { x: cx + 2, y: cy + ch - 14, w: 5, h: 6 },
      { x: cx + 1, y: cy + ch - 18, w: 7, h: 5 },
      { x: cx + 0, y: cy + ch - 22, w: 9, h: 5 },
      { x: cx + 1, y: cy + ch - 25, w: 7, h: 4 },
      { x: cx + 2, y: cy + ch - 27, w: 5, h: 3 },
      { x: cx + 3, y: cy + ch - 28, w: 3, h: 2 },
    ];
    for (var li = 0; li < layers.length; li++) {
      var l = layers[li];
      g.fillRect(l.x, l.y, l.w, l.h);
      // Dark green variation
      g.fillStyle = '#0d1a08'; g.fillRect(l.x + 1, l.y, l.w - 2, 1);
      g.fillStyle = '#0a1205';
    }
    // Tree edge highlight
    g.fillStyle = '#1a2f0e';
    g.fillRect(cx + 6, cy + ch - 26, 1, 20);

    // ── Village at bottom — warm lights in the valley ──
    var villageY = cy + ch - 7;
    g.fillStyle = '#0f1a08';
    g.fillRect(cx + 8, villageY, cw - 8, ch - (villageY - cy));

    var hillPixels = [
      { x: cx + 8,  w: 10, dy: 1 },
      { x: cx + 14, w: 8,  dy: 0 },
      { x: cx + 20, w: 12, dy: 1 },
      { x: cx + 30, w: 6,  dy: 2 },
      { x: cx + 34, w: 8,  dy: 1 },
      { x: cx + 40, w: 10, dy: 0 },
      { x: cx + 48, w: 8,  dy: 2 },
      { x: cx + 54, w: 5,  dy: 1 },
    ];
    g.fillStyle = '#141f0a';
    for (var hi = 0; hi < hillPixels.length; hi++) {
      var hp = hillPixels[hi];
      g.fillRect(hp.x, villageY - hp.dy, hp.w, 2 + hp.dy);
    }

    // Village window lights
    var villageWindows = [
      { x: cx + 18, y: villageY - 2, c: '#d4a020' },
      { x: cx + 24, y: villageY - 3, c: '#c89018' },
      { x: cx + 30, y: villageY - 2, c: '#e0b030' },
      { x: cx + 35, y: villageY - 2, c: '#d09820' },
      { x: cx + 41, y: villageY - 1, c: '#c88818' },
      { x: cx + 46, y: villageY - 3, c: '#e0a028' },
      { x: cx + 52, y: villageY - 2, c: '#d09018' },
    ];
    for (var wi = 0; wi < villageWindows.length; wi++) {
      var wn = villageWindows[wi];
      g.fillStyle = wn.c; g.fillRect(wn.x, wn.y, 2, 2);
      var wgrd = g.createRadialGradient(wn.x + 1, wn.y + 1, 0, wn.x + 1, wn.y + 1, 3);
      wgrd.addColorStop(0, 'rgba(220,180,30,0.3)');
      wgrd.addColorStop(1, 'rgba(220,180,30,0)');
      g.fillStyle = wgrd; g.fillRect(wn.x - 2, wn.y - 2, 6, 6);
    }

    // ── Night sky micro-detail: faint star field ──
    g.fillStyle = 'rgba(200,220,255,0.35)';
    var microStars = [[13,15],[21,17],[29,9],[36,14],[45,7],[55,15],[8,19],[48,17]];
    for (var ms = 0; ms < microStars.length; ms++) {
      g.fillRect(microStars[ms][0], microStars[ms][1], 1, 1);
    }

    // Return [leftTile, rightTile] each 32x32
    var left = makeCanvas(T, T), right = makeCanvas(T, T);
    left.getContext('2d').drawImage(full, 0, 0);   // draws left 32px
    right.getContext('2d').drawImage(full, -T, 0); // shifts full image left by 32px
    return [left, right];
  }

  // ── The Kiss (Klimt) — 32×64 wall painting, stored as top/bottom halves ──
  // Tile 29 = top 32px, Tile 30 = bottom 32px
  function renderTheKiss() {
    var W = 32, H = 64;
    var full = makeCanvas(W, H), g = full.getContext('2d');

    // ── Ornate gold frame (2px border) ──
    g.fillStyle = '#7a4e10'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#d4a030';
    g.fillRect(0, 0, W, 2); g.fillRect(0, H - 2, W, 2);
    g.fillRect(0, 0, 2, H); g.fillRect(W - 2, 0, 2, H);
    // Frame inner bevel
    g.fillStyle = '#b08820';
    g.fillRect(2, 2, W - 4, 1); g.fillRect(2, H - 3, W - 4, 1);
    g.fillRect(2, 2, 1, H - 4); g.fillRect(W - 3, 2, 1, H - 4);
    // Corner ornament dots
    g.fillStyle = '#e8c040';
    var corners = [[2,2],[W-3,2],[2,H-3],[W-3,H-3]];
    for (var ci2 = 0; ci2 < corners.length; ci2++) {
      g.fillRect(corners[ci2][0]-0.5, corners[ci2][1]-0.5, 2, 2);
    }

    // ── Canvas area ──
    var cx = 3, cy = 3, cw = W - 6, ch = H - 6;

    // ── Klimt gold/amber background ──
    var bgGrd = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
    bgGrd.addColorStop(0, '#c8820a');
    bgGrd.addColorStop(0.3, '#e0a020');
    bgGrd.addColorStop(0.6, '#d4901a');
    bgGrd.addColorStop(1, '#a06008');
    g.fillStyle = bgGrd; g.fillRect(cx, cy, cw, ch);

    // ── Gold geometric mosaic pattern — Klimt's signature style ──
    var goldPx = '#f0c040', goldMid = '#d4a020', goldDark = '#a87010';
    var mosaics = [
      {x:4,  y:5,  w:3, h:2, c:goldPx},  {x:9,  y:4,  w:2, h:3, c:goldMid},
      {x:14, y:6,  w:3, h:2, c:goldDark},{x:19, y:5,  w:2, h:2, c:goldPx},
      {x:4,  y:10, w:2, h:3, c:goldMid}, {x:8,  y:11, w:3, h:2, c:goldDark},
      {x:13, y:9,  w:2, h:3, c:goldPx},  {x:18, y:10, w:3, h:2, c:goldMid},
      {x:4,  y:50, w:2, h:3, c:goldMid}, {x:8,  y:51, w:3, h:2, c:goldPx},
      {x:14, y:49, w:2, h:4, c:goldDark},{x:19, y:50, w:2, h:3, c:goldMid},
      {x:5,  y:55, w:3, h:2, c:goldPx},  {x:12, y:54, w:4, h:2, c:goldDark},
      {x:18, y:55, w:2, h:3, c:goldPx},
    ];
    for (var mi = 0; mi < mosaics.length; mi++) {
      var mo = mosaics[mi];
      g.fillStyle = mo.c; g.fillRect(mo.x, mo.y, mo.w, mo.h);
    }
    // Diamond ornaments
    g.fillStyle = 'rgba(255,220,80,0.3)';
    var klimtDiamonds = [[6,18],[15,15],[21,20],[5,45],[19,43],[12,48]];
    for (var dmi = 0; dmi < klimtDiamonds.length; dmi++) {
      var dm2 = klimtDiamonds[dmi];
      g.beginPath(); g.moveTo(dm2[0],dm2[1]-2); g.lineTo(dm2[0]+2,dm2[1]);
      g.lineTo(dm2[0],dm2[1]+2); g.lineTo(dm2[0]-2,dm2[1]); g.closePath(); g.fill();
    }

    // ── Two figures embracing ──
    var faceF = '#f0c8a0', faceM = '#d4a878';
    // Female head (top center-left)
    var fhx = cx + 6, fhy = cy + 2;
    g.fillStyle = faceF; g.beginPath(); g.arc(fhx, fhy + 3, 3.5, 0, Math.PI * 2); g.fill();
    // Hair (dark brown, flowing)
    g.fillStyle = '#2a1808';
    g.fillRect(fhx - 3, fhy, 7, 3);
    g.fillRect(fhx - 4, fhy + 2, 3, 5);
    // Eyes closed (intimate)
    g.fillStyle = '#8a5030'; g.fillRect(fhx - 1, fhy + 2, 2, 0.8);
    // Cheek blush
    g.fillStyle = 'rgba(240,140,100,0.35)';
    g.beginPath(); g.arc(fhx - 1.5, fhy + 4, 1.5, 0, Math.PI * 2); g.fill();

    // Male head
    var mhx = cx + 14, mhy = cy + 1;
    g.fillStyle = faceM; g.beginPath(); g.arc(mhx, mhy + 3, 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1a1008';
    g.fillRect(mhx - 3, mhy, 6, 2);
    g.fillRect(mhx + 2, mhy + 1, 2, 4);
    g.fillStyle = '#5a3010'; g.fillRect(mhx - 1, mhy + 2, 2, 0.7);
    // Neck
    g.fillStyle = faceM; g.fillRect(mhx - 1, mhy + 5, 3, 3);

    // ── Robes ──
    var robeTop = cy + 8;
    // Female robe: cream with flower pattern
    g.fillStyle = '#e8e0d0'; g.fillRect(cx + 3, robeTop, 12, 30);
    var robeFlowers = [[5,14],[8,20],[11,17],[6,24],[9,28],[12,22],[5,31],[10,34]];
    for (var fi = 0; fi < robeFlowers.length; fi++) {
      var fp = robeFlowers[fi];
      g.fillStyle = '#e05858'; g.beginPath(); g.arc(cx + fp[0], cy + fp[1], 1, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f0e040'; g.fillRect(cx + fp[0] - 0.5, cy + fp[1] - 0.5, 1, 1);
    }
    // Male robe: gold/amber geometric
    g.fillStyle = '#c88010'; g.fillRect(cx + 12, robeTop, 11, 30);
    var robePatterns = [
      [13,10,3,3,'#e8c040'],[14,15,2,2,'#f0d050'],
      [13,20,3,2,'#d4a820'],[15,25,2,3,'#e8c040'],[13,30,3,2,'#d4a020']
    ];
    for (var rp = 0; rp < robePatterns.length; rp++) {
      var rpt = robePatterns[rp];
      g.fillStyle = rpt[4]; g.fillRect(cx + rpt[0], cy + rpt[1], rpt[2], rpt[3]);
    }
    // Black circles on male robe
    g.fillStyle = 'rgba(20,10,5,0.5)';
    var robeDots = [[13,12],[16,17],[14,23],[13,28],[15,31]];
    for (var rdc = 0; rdc < robeDots.length; rdc++) {
      g.beginPath(); g.arc(cx+robeDots[rdc][0], cy+robeDots[rdc][1], 1, 0, Math.PI*2); g.fill();
    }

    // ── Flower meadow at bottom ──
    var meadowY = cy + ch - 10;
    g.fillStyle = '#2a4a10'; g.fillRect(cx, meadowY, cw, ch - (meadowY - cy));
    var meadowFlowers = [
      {x:4, y:meadowY+2, c:'#ff6040'}, {x:7, y:meadowY+4, c:'#ffd040'},
      {x:10,y:meadowY+1, c:'#ff8060'}, {x:13,y:meadowY+3, c:'#ffffff'},
      {x:16,y:meadowY+2, c:'#ffb040'}, {x:19,y:meadowY+4, c:'#ff6060'},
      {x:22,y:meadowY+1, c:'#ffd860'}, {x:6, y:meadowY+6, c:'#ff9050'},
      {x:9, y:meadowY+5, c:'#ffe060'}, {x:15,y:meadowY+6, c:'#ff7040'},
      {x:20,y:meadowY+5, c:'#ffffff'},
    ];
    for (var mf = 0; mf < meadowFlowers.length; mf++) {
      var mfl = meadowFlowers[mf];
      g.fillStyle = mfl.c; g.beginPath(); g.arc(mfl.x, mfl.y, 1, 0, Math.PI*2); g.fill();
      g.fillStyle = '#3a6010'; g.fillRect(mfl.x, mfl.y + 1, 1, 2);
    }

    // Return [topTile, bottomTile]
    var top = makeCanvas(T, T), bot = makeCanvas(T, T);
    top.getContext('2d').drawImage(full, 0, 0);
    bot.getContext('2d').drawImage(full, 0, -T);
    return [top, bot];
  }

  // ── Kintsugi Coffee Cup — on counter surface, symbolic centerpiece ──
  // Tile 31: composited over a counter tile
  function renderKintsugiCup() {
    var c = makeCanvas(), g = c.getContext('2d');
    // Draw counter base underneath
    var counter = renderCounter();
    g.drawImage(counter, 0, 0);

    // ── Saucer ──
    var sx = T / 2, sy = T - 9;
    // Saucer shadow
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.beginPath(); g.ellipse(sx, sy + 2, 9, 2.5, 0, 0, Math.PI * 2); g.fill();
    // Saucer body
    g.fillStyle = '#e8e0d4';
    g.beginPath(); g.ellipse(sx, sy, 9, 2.5, 0, 0, Math.PI * 2); g.fill();
    // Saucer rim highlight
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.beginPath(); g.ellipse(sx, sy - 0.5, 7, 1.5, 0, 0, Math.PI); g.fill();
    // Gold crack on saucer
    g.strokeStyle = '#d4a020'; g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(sx - 5, sy); g.quadraticCurveTo(sx - 1, sy - 1, sx + 3, sy + 0.5);
    g.stroke();

    // ── Cup body ──
    var cpy = sy - 12;
    // Cup shadow
    g.fillStyle = 'rgba(0,0,0,0.15)';
    g.beginPath(); g.ellipse(sx, sy - 0.5, 6.5, 1.5, 0, 0, Math.PI * 2); g.fill();
    // Cup trapezoid shape
    g.fillStyle = '#ede6da';
    g.beginPath();
    g.moveTo(sx - 6, cpy);
    g.lineTo(sx + 6, cpy);
    g.lineTo(sx + 4.5, sy - 1);
    g.lineTo(sx - 4.5, sy - 1);
    g.closePath(); g.fill();
    // Cup rim
    g.fillStyle = '#d8d0c4'; g.fillRect(sx - 6, cpy, 12, 1.5);
    // Cup interior (dark coffee)
    g.fillStyle = '#3a1a08';
    g.beginPath(); g.ellipse(sx, cpy + 1, 5, 1.2, 0, 0, Math.PI * 2); g.fill();
    // Coffee surface + foam
    g.fillStyle = '#6a3a18';
    g.beginPath(); g.ellipse(sx, cpy + 1, 4, 1, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#c89060';
    g.beginPath(); g.ellipse(sx, cpy + 1, 2.5, 0.6, 0, 0, Math.PI * 2); g.fill();
    // Handle
    g.strokeStyle = '#d8d0c4'; g.lineWidth = 1.5;
    g.beginPath();
    g.arc(sx + 6.5, cpy + 5, 2.5, -Math.PI * 0.4, Math.PI * 0.4);
    g.stroke();

    // ── Kintsugi gold crack lines ──
    // Glow pass (blurred, wide)
    g.shadowColor = '#ffd040'; g.shadowBlur = 3;
    g.strokeStyle = 'rgba(255,220,60,0.55)'; g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(sx - 4, cpy + 2);
    g.lineTo(sx - 1, cpy + 4);
    g.lineTo(sx + 1, cpy + 5.5);
    g.lineTo(sx + 3, sy - 2);
    g.stroke();
    g.shadowBlur = 0;
    // Main crack (sharp gold line on top)
    var kGrd = g.createLinearGradient(sx - 5, cpy + 1, sx + 4, sy - 2);
    kGrd.addColorStop(0, 'rgba(255,200,40,0.9)');
    kGrd.addColorStop(0.5, 'rgba(255,215,60,1.0)');
    kGrd.addColorStop(1, 'rgba(220,165,20,0.8)');
    g.strokeStyle = kGrd; g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(sx - 4, cpy + 2);
    g.lineTo(sx - 1, cpy + 4);
    g.lineTo(sx + 1, cpy + 5.5);
    g.lineTo(sx + 3, sy - 2);
    g.stroke();
    // Branch cracks
    g.strokeStyle = '#d4a020'; g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(sx - 1, cpy + 4);
    g.lineTo(sx - 3.5, cpy + 6);
    g.lineTo(sx - 2.5, sy - 3);
    g.stroke();
    g.beginPath();
    g.moveTo(sx + 1, cpy + 5.5);
    g.lineTo(sx + 3.5, cpy + 7);
    g.stroke();

    // ── Steam wisps ──
    g.strokeStyle = 'rgba(220,215,210,0.5)'; g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(sx - 1, cpy - 1);
    g.quadraticCurveTo(sx - 3, cpy - 4, sx - 1, cpy - 7);
    g.stroke();
    g.strokeStyle = 'rgba(220,215,210,0.35)'; g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(sx + 2, cpy - 1);
    g.quadraticCurveTo(sx + 4, cpy - 3.5, sx + 2, cpy - 6);
    g.stroke();

    return c;
  }

  // ── Vinyl Record Player + Bach Score — on bar back shelf ──
  // Tile 32: composited over a bar shelf tile
  function renderVinylPlayer() {
    var c = makeCanvas(), g = c.getContext('2d');
    // Draw bar shelf base underneath
    var shelf = renderBarShelf(2);
    g.drawImage(shelf, 0, 0);

    // ── Vinyl player on upper shelf area ──
    var bx = 3, by = 0;

    // Dark wood plinth/base
    g.fillStyle = '#2a1808'; g.fillRect(bx, by + 4, 18, 6);
    // Wood grain
    g.fillStyle = 'rgba(80,50,20,0.3)';
    g.fillRect(bx + 1, by + 5, 16, 1);
    g.fillRect(bx + 2, by + 7, 14, 1);
    // Plinth highlight
    g.fillStyle = 'rgba(160,100,40,0.2)'; g.fillRect(bx, by + 4, 18, 1);

    // ── Vinyl disc ──
    var dx = bx + 8, dy = by + 6;
    // Shadow
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.arc(dx + 0.5, dy + 0.5, 5.5, 0, Math.PI * 2); g.fill();
    // Disc
    g.fillStyle = '#0d0d0d';
    g.beginPath(); g.arc(dx, dy, 5.5, 0, Math.PI * 2); g.fill();
    // Vinyl grooves (concentric rings)
    for (var vr = 2; vr <= 5; vr++) {
      g.strokeStyle = 'rgba(40,40,40,0.6)'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(dx, dy, vr, 0, Math.PI * 2); g.stroke();
    }
    // Center label (cream — Bach)
    g.fillStyle = '#e8dfc8';
    g.beginPath(); g.arc(dx, dy, 2, 0, Math.PI * 2); g.fill();
    // "J.S.B." pixel blocks on label
    g.fillStyle = '#3a2808';
    g.fillRect(dx - 1,   dy - 1.2, 0.6, 0.5);
    g.fillRect(dx - 0.5, dy - 0.7, 0.5, 1.5);
    g.fillRect(dx - 1,   dy + 0.8, 0.7, 0.4);
    g.fillRect(dx + 0.2, dy - 1.2, 0.4, 2.2);
    g.fillRect(dx + 0.5, dy - 1.2, 0.6, 0.4);
    g.fillRect(dx + 0.5, dy - 0.1, 0.6, 0.4);
    g.fillRect(dx + 0.5, dy + 1,   0.6, 0.4);
    // Spindle hole
    g.fillStyle = '#0d0d0d';
    g.beginPath(); g.arc(dx, dy, 0.4, 0, Math.PI * 2); g.fill();

    // ── Tonearm ──
    var ax = bx + 16, ay = by + 5;
    g.fillStyle = '#888888';
    g.beginPath(); g.arc(ax, ay, 1.2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#aaaaaa'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(dx + 3, dy - 2); g.stroke();
    g.fillStyle = '#cccccc'; g.fillRect(dx + 2.5, dy - 2.5, 1.5, 1);

    // ── Record sleeve (leaning on wall, right of player) ──
    var slx = bx + 19;
    g.fillStyle = '#1a1008'; g.fillRect(slx, by, 8, 10);
    g.fillStyle = '#c8a030'; g.fillRect(slx + 1, by + 1, 6, 6);
    g.fillStyle = '#2a1808'; g.fillRect(slx + 2, by + 2, 4, 4);
    g.fillStyle = '#d4b040'; g.fillRect(slx + 3, by + 3, 2, 2);
    g.fillStyle = '#e8c050'; g.fillRect(slx + 1, by + 7.5, 6, 0.8);

    // ── Open score book (sheet music) on lower portion ──
    var scx = 1, scy = by + 14;
    g.fillStyle = '#f0ebe0';
    // Left page
    g.beginPath();
    g.moveTo(scx, scy + 6); g.lineTo(scx, scy + 1); g.lineTo(scx + 12, scy); g.lineTo(scx + 12, scy + 6);
    g.closePath(); g.fill();
    // Right page
    g.beginPath();
    g.moveTo(scx + 12, scy); g.lineTo(scx + 24, scy + 1); g.lineTo(scx + 24, scy + 6); g.lineTo(scx + 12, scy + 6);
    g.closePath(); g.fill();
    // Spine shadow
    g.fillStyle = 'rgba(60,40,20,0.3)'; g.fillRect(scx + 11, scy, 2, 6);
    // Staff lines — left page
    g.strokeStyle = '#888070'; g.lineWidth = 0.4;
    for (var sl = 0; sl < 5; sl++) {
      g.beginPath(); g.moveTo(scx + 1, scy + 1.5 + sl * 0.9); g.lineTo(scx + 11, scy + 1.5 + sl * 0.9); g.stroke();
    }
    // Staff lines — right page
    for (var sr = 0; sr < 5; sr++) {
      g.beginPath(); g.moveTo(scx + 13, scy + 1.5 + sr * 0.9); g.lineTo(scx + 23, scy + 1.5 + sr * 0.9); g.stroke();
    }
    // Music notes
    g.fillStyle = '#2a2020';
    var notePositions = [
      {x:3,y:scy+2},{x:5,y:scy+2.5},{x:7,y:scy+1.8},{x:9,y:scy+3},
      {x:15,y:scy+2},{x:17,y:scy+2.8},{x:19,y:scy+2.3},{x:21,y:scy+3.2}
    ];
    for (var ni = 0; ni < notePositions.length; ni++) {
      var n = notePositions[ni];
      g.beginPath(); g.ellipse(scx + n.x, n.y, 0.9, 0.65, -0.3, 0, Math.PI*2); g.fill();
      g.fillRect(scx + n.x + 0.7, n.y - 3, 0.5, 3);
    }
    // Treble clef hint
    g.strokeStyle = '#2a2020'; g.lineWidth = 0.6;
    g.beginPath(); g.arc(scx + 1.5, scy + 3, 1, -Math.PI * 0.5, Math.PI * 1.5); g.stroke();

    return c;
  }

  function init() {
    cache[0] = renderWoodFloor('#3e2723', 'rgba(30,15,10,0.3)');
    cache[1] = renderWoodFloor('#2a1f14', 'rgba(20,10,5,0.3)');
    cache[2] = renderCarpet();
    cache[3] = renderWoodFloor('#5c3d2e', 'rgba(40,25,15,0.25)');
    cache[10] = renderWall();
    cache[11] = renderWindow();
    cache[12] = renderCounter();
    cache[13] = renderBookshelf();
    cache[14] = renderChairFloor();
    // Generate 6 unique table variants
    cache[15] = [];
    for (var tv = 0; tv < 6; tv++) cache[15].push(renderTable());
    cache[16] = renderDoor();
    cache[17] = renderNewsWall();
    cache[18] = renderWarRoomDoor();
    cache[19] = renderCatWindow();
    cache[20] = renderCoffeeMachineBase();
    cache[21] = renderClock();
    cache[22] = renderOpenSign();
    cache[23] = renderCoatRack();
    cache[24] = renderCruzPos();
    cache[25] = renderCounterFront();
    // Bar back shelves — 3 variants (different bottle/glass arrangements)
    cache[26] = [];
    for (var bv = 0; bv < 3; bv++) cache[26].push(renderBarShelf(bv));
    // ── Cultural masterpieces ──
    var starryParts = renderStarryNight();
    cache[27] = starryParts[0]; // Starry Night left half
    cache[28] = starryParts[1]; // Starry Night right half
    var kissParts = renderTheKiss();
    cache[29] = kissParts[0]; // The Kiss top half
    cache[30] = kissParts[1]; // The Kiss bottom half
    cache[31] = renderKintsugiCup();    // Kintsugi coffee cup on counter
    cache[32] = renderVinylPlayer();    // Vinyl record player + Bach score
    // pre-render ambience overlay
    ambienceCanvas = makeCanvas(15 * T, 11 * T);
    renderAmbienceOnce(ambienceCanvas.getContext('2d'));
  }

  function renderAmbienceOnce(g) {
    var W = 15 * T, H = 11 * T;

    // 1. Base night tint — everything starts slightly dark
    g.fillStyle = 'rgba(20,18,30,0.08)';
    g.fillRect(0, 0, W, H);

    // 2. Edison bulb warm pools — BAR is the brightest anchor
    //    3 counter lamps (bright) + 2 seating lamps (dimmer)
    var bulbs = [
      // ── Counter bar lamps (the visual anchor — 2x brighter than seating) ──
      { x: 4.5, y: 1.5, r: 3.5, a: 0.22 },   // left bar lamp
      { x: 7.5, y: 1.5, r: 3.5, a: 0.25 },   // center bar lamp (Cruz position, brightest)
      { x: 10.5, y: 1.5, r: 3.5, a: 0.22 },  // right bar lamp
      // ── Seating zone lamps (subdued — you're in the audience, not the stage) ──
      { x: 4, y: 5.5, r: 2.5, a: 0.06 },     // left seating
      { x: 8, y: 5.5, r: 2.5, a: 0.06 },     // right seating
    ];
    for (var i = 0; i < bulbs.length; i++) {
      var b = bulbs[i];
      var bx = b.x * T + T / 2, by = b.y * T;
      var grad = g.createRadialGradient(bx, by, 4, bx, by + T * 2.5, T * b.r);
      grad.addColorStop(0, 'rgba(212,160,87,' + b.a.toFixed(3) + ')');
      grad.addColorStop(0.3, 'rgba(212,160,87,' + (b.a * 0.4).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(212,160,87,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      // Tiny bulb dot (brighter for counter lamps)
      var dotAlpha = b.a > 0.15 ? 0.4 : 0.2;
      g.fillStyle = 'rgba(255,220,150,' + dotAlpha.toFixed(2) + ')';
      g.beginPath(); g.arc(bx, by, b.a > 0.15 ? 3 : 2, 0, Math.PI * 2); g.fill();
      // Pendant lamp fixture hint (tiny dark cap above bright bulbs)
      if (b.a > 0.15) {
        g.fillStyle = 'rgba(40,30,20,0.15)';
        g.fillRect(bx - 3, by - 3, 6, 2);
      }
    }

    // 3. Window cold spill — blue light bleeding onto floor near windows
    for (var wx = 1; wx <= 5; wx++) {
      var wcx = wx * T + T / 2, wcy = T * 0.5;
      var wGrd = g.createRadialGradient(wcx, wcy, 0, wcx, wcy + T * 2.5, T * 3);
      wGrd.addColorStop(0, 'rgba(80,120,180,0.06)');
      wGrd.addColorStop(0.5, 'rgba(80,120,180,0.02)');
      wGrd.addColorStop(1, 'rgba(80,120,180,0)');
      g.fillStyle = wGrd;
      g.fillRect(0, 0, W, T * 5);
    }

    // 4. Ambient occlusion — darken edges where walls meet floor
    // Top wall shadow casting down
    var topShadow = g.createLinearGradient(0, T * 1, 0, T * 3);
    topShadow.addColorStop(0, 'rgba(0,0,0,0.12)');
    topShadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = topShadow; g.fillRect(0, T, W, T * 2);
    // Left wall shadow
    var leftShadow = g.createLinearGradient(0, 0, T * 2, 0);
    leftShadow.addColorStop(0, 'rgba(0,0,0,0.08)');
    leftShadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = leftShadow; g.fillRect(0, 0, T * 2, H);
    // Right wall shadow
    var rightShadow = g.createLinearGradient(W, 0, W - T * 2, 0);
    rightShadow.addColorStop(0, 'rgba(0,0,0,0.08)');
    rightShadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rightShadow; g.fillRect(W - T * 2, 0, T * 2, H);
    // Bottom shadow
    var botShadow = g.createLinearGradient(0, H, 0, H - T * 1.5);
    botShadow.addColorStop(0, 'rgba(0,0,0,0.1)');
    botShadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = botShadow; g.fillRect(0, H - T * 1.5, W, T * 1.5);

    // 5. Counter highlight — strong warm wash behind the entire bar (the stage)
    var barGrd = g.createRadialGradient(7.5 * T, 2 * T, 0, 7.5 * T, 2 * T, T * 7);
    barGrd.addColorStop(0, 'rgba(212,160,87,0.18)');
    barGrd.addColorStop(0.3, 'rgba(212,160,87,0.08)');
    barGrd.addColorStop(0.7, 'rgba(212,160,87,0.02)');
    barGrd.addColorStop(1, 'rgba(212,160,87,0)');
    g.fillStyle = barGrd; g.fillRect(0, 0, W, H);
    // Secondary warm wash (wider, subtler — light spilling onto floor)
    var barSpill = g.createLinearGradient(0, T * 2, 0, T * 5);
    barSpill.addColorStop(0, 'rgba(200,150,80,0.06)');
    barSpill.addColorStop(1, 'rgba(200,150,80,0)');
    g.fillStyle = barSpill; g.fillRect(T * 2, T * 2, T * 11, T * 3);

    // 6. Table candle/lamp pools — warm spots at each table position
    //    Tables at (2,5)(5,5)(8,5) / (2,6)(5,6)(8,6) / (2,7)(5,7)(8,7)
    var tableXs = [2, 5, 8];
    var tableYs = [5, 6, 7];
    for (var ti = 0; ti < tableXs.length; ti++) {
      for (var tj = 0; tj < tableYs.length; tj++) {
        var tlx = tableXs[ti] * T + T / 2;
        var tly = tableYs[tj] * T + T / 2;
        var tGrd = g.createRadialGradient(tlx, tly, 0, tlx, tly, T * 1.8);
        tGrd.addColorStop(0, 'rgba(220,175,100,0.06)');
        tGrd.addColorStop(0.5, 'rgba(220,175,100,0.02)');
        tGrd.addColorStop(1, 'rgba(220,175,100,0)');
        g.fillStyle = tGrd;
        g.fillRect(tlx - T * 2, tly - T * 2, T * 4, T * 4);
      }
    }

    // 7. Open sign warm spill onto nearby floor (sign at x=13, y=3)
    var signX = 13 * T + T / 2, signY = 3 * T + T / 2;
    var signGrd = g.createRadialGradient(signX, signY, 0, signX, signY + T, T * 2.5);
    signGrd.addColorStop(0, 'rgba(255,160,40,0.06)');
    signGrd.addColorStop(0.4, 'rgba(255,140,20,0.02)');
    signGrd.addColorStop(1, 'rgba(255,120,0,0)');
    g.fillStyle = signGrd; g.fillRect(signX - T * 3, signY - T, T * 6, T * 4);

    // 8. Cat window moonlight pool (cat window at x=12-13, y=9)
    var catWx = 12.5 * T, catWy = 9 * T;
    var catGrd = g.createRadialGradient(catWx, catWy, 0, catWx, catWy - T, T * 2);
    catGrd.addColorStop(0, 'rgba(100,140,200,0.04)');
    catGrd.addColorStop(1, 'rgba(100,140,200,0)');
    g.fillStyle = catGrd; g.fillRect(catWx - T * 2, catWy - T * 2, T * 4, T * 3);

    // 9. Steam wisps from coffee machine area (x≈10, y≈2)
    var steamX = 10 * T + T / 2, steamY = 2 * T;
    g.strokeStyle = 'rgba(200,200,210,0.04)'; g.lineWidth = 2;
    // Wisp 1 (lazy S-curve rising)
    g.beginPath();
    g.moveTo(steamX, steamY);
    g.quadraticCurveTo(steamX + 6, steamY - T * 0.6, steamX - 3, steamY - T * 1.2);
    g.quadraticCurveTo(steamX + 8, steamY - T * 1.8, steamX + 2, steamY - T * 2.2);
    g.stroke();
    // Wisp 2 (offset)
    g.strokeStyle = 'rgba(200,200,210,0.03)'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(steamX + 4, steamY + 2);
    g.quadraticCurveTo(steamX - 4, steamY - T * 0.5, steamX + 5, steamY - T);
    g.quadraticCurveTo(steamX - 2, steamY - T * 1.5, steamX + 3, steamY - T * 2);
    g.stroke();

    // 10. Dust motes in light beams (tiny warm specks floating in Edison light cones)
    var dustMotes = [
      [4.3 * T, 2.5 * T, 0.06], [4.7 * T, 3.2 * T, 0.04],
      [8.2 * T, 5 * T, 0.05],   [8.5 * T, 4.2 * T, 0.03],
      [3.8 * T, 5.8 * T, 0.04], [5.3 * T, 6.5 * T, 0.05],
      [7.1 * T, 6.8 * T, 0.03], [2.5 * T, 4.5 * T, 0.04],
      [9.2 * T, 3.8 * T, 0.03], [6.5 * T, 5.2 * T, 0.04],
    ];
    for (var di = 0; di < dustMotes.length; di++) {
      var dm = dustMotes[di];
      g.fillStyle = 'rgba(255,230,160,' + dm[2].toFixed(3) + ')';
      g.beginPath(); g.arc(dm[0], dm[1], 1.5, 0, Math.PI * 2); g.fill();
    }

    // 11. Bookshelf warm glow spill (grimoire aura bleeding into room, x≈11-12, y≈8)
    var grimX = 11.5 * T, grimY = 8 * T + T / 2;
    var grimGlow = g.createRadialGradient(grimX, grimY, 0, grimX, grimY, T * 2);
    grimGlow.addColorStop(0, 'rgba(245,180,60,0.03)');
    grimGlow.addColorStop(0.5, 'rgba(245,166,35,0.01)');
    grimGlow.addColorStop(1, 'rgba(245,166,35,0)');
    g.fillStyle = grimGlow; g.fillRect(grimX - T * 2, grimY - T * 2, T * 4, T * 4);

    // 12. Aisle light breadcrumbs — pendant lamp pools along the walkway
    //     Visual guide: door → counter. Light says "walk here."
    var aisleX = 7.5 * T; // center of aisle (col 7)
    var aisleSpots = [
      { y: 4.5, r: 2.5, a: 0.10 },  // near counter — brightest
      { y: 6.0, r: 2.0, a: 0.07 },  // mid seating
      { y: 7.5, r: 2.0, a: 0.06 },  // mid-lower
      { y: 9.0, r: 2.0, a: 0.08 },  // near door — welcoming
    ];
    for (var ai = 0; ai < aisleSpots.length; ai++) {
      var asp = aisleSpots[ai];
      var aly = asp.y * T;
      var alGrd = g.createRadialGradient(aisleX, aly, 2, aisleX, aly + T, T * asp.r);
      alGrd.addColorStop(0, 'rgba(220,175,110,' + asp.a.toFixed(3) + ')');
      alGrd.addColorStop(0.3, 'rgba(220,175,110,' + (asp.a * 0.35).toFixed(3) + ')');
      alGrd.addColorStop(1, 'rgba(220,175,110,0)');
      g.fillStyle = alGrd;
      g.fillRect(aisleX - T * 3, aly - T * 2, T * 6, T * 4);
      // Tiny pendant fixture dot (visible during intro camera pan)
      g.fillStyle = 'rgba(255,220,150,' + (asp.a * 1.5).toFixed(3) + ')';
      g.beginPath(); g.arc(aisleX, aly - T * 0.3, 1.5, 0, Math.PI * 2); g.fill();
    }

    // 12b. Floor wear paths — darkened walkway from door to counter
    //     Main traffic path: door(x≈7,y≈10) → up to counter(x≈7,y���3)
    g.fillStyle = 'rgba(30,20,12,0.03)';
    // Vertical walkway (door to counter)
    g.fillRect(6 * T + 4, 4 * T, T * 3 - 8, 6 * T);
    // Horizontal path along counter (row 3-4)
    g.fillRect(2 * T, 3 * T + 4, T * 8, T * 2 - 8);
    // Scuff marks along walkway (short dark streaks)
    g.strokeStyle = 'rgba(20,12,6,0.025)'; g.lineWidth = 1.5;
    var scuffs = [
      [7 * T + 4, 5 * T, 7 * T + 14, 5 * T + 2],
      [6.5 * T, 6 * T + 8, 6.5 * T + 10, 6 * T + 10],
      [7.5 * T, 7 * T + 4, 7.5 * T + 8, 7 * T + 5],
      [7 * T - 2, 8 * T + 6, 7 * T + 12, 8 * T + 7],
      [6 * T + 6, 9 * T, 6 * T + 16, 9 * T + 1],
      [4 * T + 4, 3.5 * T, 4 * T + 12, 3.5 * T + 1],
      [8 * T + 2, 4 * T + 6, 8 * T + 10, 4 * T + 7],
      [3 * T + 8, 4 * T + 2, 3 * T + 16, 4 * T + 3],
    ];
    for (var si = 0; si < scuffs.length; si++) {
      var sc = scuffs[si];
      g.beginPath(); g.moveTo(sc[0], sc[1]); g.lineTo(sc[2], sc[3]); g.stroke();
    }
    // Threshold wear (darker area right at door)
    var doorWear = g.createRadialGradient(7.5 * T, 10 * T, 0, 7.5 * T, 10 * T, T * 1.5);
    doorWear.addColorStop(0, 'rgba(20,12,6,0.04)');
    doorWear.addColorStop(1, 'rgba(20,12,6,0)');
    g.fillStyle = doorWear; g.fillRect(6 * T, 9 * T, T * 3, T * 2);

    // 13. Window light shafts — diagonal beams of streetlight through windows
    //     Windows are along top wall (row 0). Light casts down-right at ~25° angle.
    g.save();
    g.globalCompositeOperation = 'screen';
    var shaftWindows = [1, 3, 5]; // window tile X positions
    for (var swi = 0; swi < shaftWindows.length; swi++) {
      var swx = shaftWindows[swi] * T + T / 2;
      var swy = T; // bottom of wall row
      // Each shaft: a narrow trapezoid of light widening as it reaches the floor
      g.beginPath();
      g.moveTo(swx - 4, swy);           // top-left of shaft (narrow at window)
      g.lineTo(swx + 4, swy);           // top-right
      g.lineTo(swx + T * 2.5, swy + T * 4.5); // bottom-right (spread wide)
      g.lineTo(swx + T * 0.8, swy + T * 4.5); // bottom-left
      g.closePath();
      // Gradient fading with distance from window
      var shaftGrd = g.createLinearGradient(swx, swy, swx + T, swy + T * 4.5);
      shaftGrd.addColorStop(0, 'rgba(120,150,200,0.03)');
      shaftGrd.addColorStop(0.3, 'rgba(120,150,200,0.02)');
      shaftGrd.addColorStop(0.7, 'rgba(100,130,180,0.01)');
      shaftGrd.addColorStop(1, 'rgba(100,130,180,0)');
      g.fillStyle = shaftGrd; g.fill();
    }
    g.restore();

    // 13b. Rain puddle reflections — elongated sheen on floor tiles beneath windows
    //      Wet night: water seeps under the sill and pools on the stone floor.
    //      Each puddle: a wide, very-flat ellipse with amber-tinted specular streak.
    //      Positioned one tile below the window row (y ≈ T*2) so they sit at
    //      the base of the wall, visible from the player's perspective.
    var puddleWindows = [1, 3, 5]; // mirror shaftWindows above
    for (var pi = 0; pi < puddleWindows.length; pi++) {
      var pcx = puddleWindows[pi] * T + T / 2 + T * 0.6; // slight rightward drift (parallax angle)
      var pcy = T * 2 + T * 0.6;                         // floor tile just below window wall

      // Wide diffuse sheen — cold blue from the streetlight outside
      var puddleGrd = g.createRadialGradient(pcx, pcy, 0, pcx, pcy, T * 1.6);
      puddleGrd.addColorStop(0,   'rgba(100,140,200,0.10)');
      puddleGrd.addColorStop(0.4, 'rgba( 80,120,180,0.05)');
      puddleGrd.addColorStop(1,   'rgba( 60,100,160,0)');
      g.save();
      g.scale(1, 0.28); // flatten vertically — puddles are shallow ellipses in top-down perspective
      g.fillStyle = puddleGrd;
      g.fillRect(pcx - T * 1.6, (pcy / 0.28) - T * 1.6, T * 3.2, T * 3.2);
      g.restore();

      // Hard amber specular streak — catches the warm interior Edison light
      // Short horizontal line near the near edge of the puddle
      var streakGrd = g.createLinearGradient(pcx - T * 0.6, pcy, pcx + T * 0.6, pcy);
      streakGrd.addColorStop(0,   'rgba(255,200,100,0)');
      streakGrd.addColorStop(0.4, 'rgba(255,200,100,0.18)');
      streakGrd.addColorStop(0.6, 'rgba(255,220,140,0.22)');
      streakGrd.addColorStop(1,   'rgba(255,200,100,0)');
      g.fillStyle = streakGrd;
      g.fillRect(pcx - T * 0.6, pcy - 1, T * 1.2, 2); // 2 px tall — just a glint
    }

    // 14. Dust motes caught in light shafts (tiny bright specks inside beams)
    var shaftDust = [
      [1.5 * T, 2 * T, 0.05], [1.8 * T, 3 * T, 0.03],
      [3.5 * T, 2.5 * T, 0.04], [4 * T, 3.8 * T, 0.03],
      [5.5 * T, 2.2 * T, 0.05], [6.2 * T, 4 * T, 0.03],
    ];
    for (var sdi = 0; sdi < shaftDust.length; sdi++) {
      var sd = shaftDust[sdi];
      g.fillStyle = 'rgba(180,200,240,' + sd[2].toFixed(3) + ')';
      g.beginPath(); g.arc(sd[0], sd[1], 0.8, 0, Math.PI * 2); g.fill();
    }

    // 15. Cinematic vignette — dark corners pull focus to the lit center aisle
    //     Center shifted upward toward counter (the stage should stay bright)
    var vigCx = W / 2, vigCy = H * 0.35; // bias toward bar area
    var vigR = Math.max(W, H) * 0.7;
    var vig = g.createRadialGradient(vigCx, vigCy, vigR * 0.35, vigCx, vigCy, vigR);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(0.5, 'rgba(0,0,0,0)');
    vig.addColorStop(0.75, 'rgba(8,6,14,0.1)');
    vig.addColorStop(1, 'rgba(8,6,14,0.35)');
    g.fillStyle = vig; g.fillRect(0, 0, W, H);

    // 15b. Corner shadow pools — the "I want to hide" tables are extra dark
    //      4 corner table clusters get additional shadow
    var corners = [
      { x: 2, y: 5 },    // top-left table
      { x: 8, y: 5 },    // top-right table (near wall)
      { x: 2, y: 7 },    // bottom-left table
      { x: 8, y: 7 },    // bottom-right table
    ];
    for (var ci = 0; ci < corners.length; ci++) {
      var crn = corners[ci];
      var ccx = crn.x * T + T / 2, ccy = crn.y * T + T / 2;
      var cGrd = g.createRadialGradient(ccx, ccy, 0, ccx, ccy, T * 2.5);
      cGrd.addColorStop(0, 'rgba(5,3,10,0.06)');
      cGrd.addColorStop(0.6, 'rgba(5,3,10,0.03)');
      cGrd.addColorStop(1, 'rgba(5,3,10,0)');
      g.fillStyle = cGrd;
      g.fillRect(ccx - T * 3, ccy - T * 3, T * 6, T * 6);
    }

    // 15c. Bottom edge extra darkness (door area = deepest shadow before you step in)
    var doorDark = g.createLinearGradient(0, H - T * 3, 0, H);
    doorDark.addColorStop(0, 'rgba(5,3,10,0)');
    doorDark.addColorStop(1, 'rgba(5,3,10,0.15)');
    g.fillStyle = doorDark; g.fillRect(0, H - T * 3, W, T * 3);
  }

  // Draw clock hands live (called each frame for tile 21)
  function drawClockHands(ctx, px, py) {
    var now = new Date();
    var h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds();
    var cx = px + T / 2, cy = py + T / 2 - 1; // match renderClock center

    ctx.save();
    ctx.lineCap = 'round';

    // ── Hour hand — bold, reads at phone scale ──
    var ha = ((h + m / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    // Drop shadow (larger offset for depth)
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx + 0.8, cy + 0.8);
    ctx.lineTo(cx + 0.8 + Math.cos(ha) * 5.5, cy + 0.8 + Math.sin(ha) * 5.5); ctx.stroke();
    // Hand body (warm dark — slight amber tint from lamp light)
    ctx.strokeStyle = '#140a02'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ha) * 5.5, cy + Math.sin(ha) * 5.5); ctx.stroke();
    // Warm rim highlight on hand
    ctx.strokeStyle = 'rgba(200,150,60,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ha) * 5.5, cy + Math.sin(ha) * 5.5); ctx.stroke();

    // ── Minute hand — bold, reaches near markers ──
    var ma = (m / 60) * Math.PI * 2 - Math.PI / 2;
    // Drop shadow
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(cx + 0.7, cy + 0.7);
    ctx.lineTo(cx + 0.7 + Math.cos(ma) * 8, cy + 0.7 + Math.sin(ma) * 8); ctx.stroke();
    // Hand body
    ctx.strokeStyle = '#1a0e04'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ma) * 8, cy + Math.sin(ma) * 8); ctx.stroke();

    // ── Second hand — vivid red, clearly visible ──
    var sa = (s / 60) * Math.PI * 2 - Math.PI / 2;
    // Shadow
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cx + 0.5, cy + 0.5);
    ctx.lineTo(cx + 0.5 + Math.cos(sa) * 7.5, cy + 0.5 + Math.sin(sa) * 7.5); ctx.stroke();
    // Hand (bright red, mobile-visible)
    ctx.strokeStyle = '#e02020'; ctx.lineWidth = 1.0;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sa) * 7.5, cy + Math.sin(sa) * 7.5); ctx.stroke();
    // Counter-balance tail
    ctx.strokeStyle = '#e02020'; ctx.lineWidth = 1.0;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.cos(sa) * 2.5, cy - Math.sin(sa) * 2.5); ctx.stroke();

    // ── Center cap (brass, on top of hands) ──
    ctx.fillStyle = '#c9a030';
    ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill();
    // Brass highlight
    ctx.fillStyle = 'rgba(255,240,160,0.55)';
    ctx.beginPath(); ctx.arc(cx - 0.4, cy - 0.4, 0.6, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  function drawTile(ctx, tileId, x, y, layer) {
    var px = x * T, py = y * T;
    var src = cache[tileId];
    // Table variants — pick by position hash
    if (Array.isArray(src)) {
      var idx = (x * 7 + y * 13) % src.length;
      ctx.drawImage(src[idx], px, py);
      return;
    }
    if (src) {
      ctx.drawImage(src, px, py);
    } else {
      // fallback for unknown tiles
      ctx.fillStyle = layer === 'floor' ? '#3e2723' : '#5c3d2e';
      ctx.fillRect(px, py, T, T);
    }
    // Live clock hands
    if (tileId === 21) drawClockHands(ctx, px, py);
  }

  function drawAmbience(ctx) {
    if (ambienceCanvas) ctx.drawImage(ambienceCanvas, 0, 0);
  }

  window.CafeTiles = { init: init, drawTile: drawTile, drawAmbience: drawAmbience, getCache: function () { return cache; }, getAmbienceCanvas: function () { return ambienceCanvas; } };
})();
