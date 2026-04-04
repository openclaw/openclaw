// Cafe Game Sprite Rendering System — Pure Canvas 2D, zero dependencies
// Game Boy Color pixel art style, pre-rendered to offscreen canvases
(function () {
  const NPC_COLORS = {
    cruz: '#f5a623', polaris: '#3498db', nova: '#e74c3c',
    mira: '#1abc9c', rigel: '#9b59b6'
  };
  const NPC_ITEMS = { cruz: 'register', polaris: 'book', nova: 'laptop', mira: 'notebook', rigel: 'phone' };
  const STATUS_COLORS = { good: '#27ae60', warn: '#f39c12', risk: '#e74c3c', green: '#27ae60', yellow: '#f39c12', red: '#e74c3c' };
  const SKIN = '#f5d6b0', HAIR = '#4a3020', HOODIE = '#c0785a', PANTS = '#3e2723';
  const SHOE = '#2c1810', HAND = '#e8b88a', EYE = '#1a1a1a', MOUTH = '#c0896e';
  const cache = {};

  function makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function px(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
  function circle(g, cx, cy, r, c) { g.fillStyle = c; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); }
  function darken(hex, n) {
    return `rgb(${Math.max(0, parseInt(hex.slice(1,3),16)-n)},${Math.max(0, parseInt(hex.slice(3,5),16)-n)},${Math.max(0, parseInt(hex.slice(5,7),16)-n)})`;
  }

  // Identity V-style: add dark outline around sprite silhouette
  function addOutline(canvas, color) {
    var w = canvas.width, h = canvas.height;
    var src = canvas.getContext('2d').getImageData(0, 0, w, h);
    var out = canvas.getContext('2d').createImageData(w, h);
    var sd = src.data, od = out.data;
    // Copy source
    for (var i = 0; i < sd.length; i++) od[i] = sd[i];
    // Parse outline color
    var r = parseInt(color.slice(1,3),16), gr = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
    // For each transparent pixel, check if any neighbor is opaque
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var idx = (y * w + x) * 4;
        if (sd[idx + 3] > 20) continue; // already has content
        // Check 4 neighbors
        var dirs = [[-1,0],[1,0],[0,-1],[0,1]];
        for (var d = 0; d < 4; d++) {
          var nx = x + dirs[d][0], ny = y + dirs[d][1];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          var ni = (ny * w + nx) * 4;
          if (sd[ni + 3] > 80) {
            od[idx] = r; od[idx+1] = gr; od[idx+2] = b; od[idx+3] = 220;
            break;
          }
        }
      }
    }
    canvas.getContext('2d').putImageData(out, 0, 0);
    return canvas;
  }

  // ---- Player (32x32) chibi pixel art ----
  function renderPlayer(dir, frame) {
    const c = makeCanvas(32, 32), g = c.getContext('2d');
    const flip = dir === 'left', facing = flip ? 'right' : dir, walk = frame === 1;
    // ── Visitor jacket: slate-blue — coolest thing in the cafe, unmistakably outside ──
    var jacketBody  = '#5a7fa8';  // mid-value slate blue: readable on any tile
    var jacketLight = '#7aa0c8';  // sky-edge shoulder catch (top light)
    var jacketShadow = '#2e4f6e'; // deep navy undercut — strong volume read at 32px
    var jacketZip   = '#a8c8e8';  // silver-blue zipper: bright enough to see at phone scale
    // Pants: cool slate-grey, clearly lighter than SHOE, clearly different from jacket
    var playerPants = '#4a5568';
    var pantsLight  = '#5e6e82';  // inner-leg highlight separates legs from each other

    // ── Visitor glow — boosted so it's actually visible, not theoretical ──
    // You walked in from outside. The room hasn't warmed you yet.
    var visitGlow = g.createRadialGradient(16, 14, 1, 16, 16, 16);
    visitGlow.addColorStop(0,   'rgba(190,210,235,0.14)');
    visitGlow.addColorStop(0.35,'rgba(190,210,235,0.06)');
    visitGlow.addColorStop(0.7, 'rgba(190,210,235,0.02)');
    visitGlow.addColorStop(1,   'rgba(190,210,235,0)');
    g.fillStyle = visitGlow;
    g.fillRect(0, 0, 32, 32);

    // ── Ground shadow (soft ellipse under feet) ──
    g.fillStyle = 'rgba(0,0,0,0.13)';
    g.beginPath(); g.ellipse(16, 30, 7, 2.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.05)';
    g.beginPath(); g.ellipse(16, 30, 9, 3.5, 0, 0, Math.PI * 2); g.fill();

    // ── Hair (all directions) ──
    px(g, 11, 2, 10, 3, HAIR); px(g, 10, 4, 12, 2, HAIR);
    // Slight cool sheen on hair top (sky reflection — visitor just came inside)
    px(g, 13, 2, 4, 1, 'rgba(190,210,235,0.12)');

    if (facing === 'up') {
      px(g, 11, 4, 10, 8, HAIR); px(g, 10, 5, 12, 6, HAIR);
      px(g, 9, 7, 2, 3, SKIN); px(g, 21, 7, 2, 3, SKIN);
      px(g, 13, 5, 6, 1, 'rgba(255,255,255,0.05)');
    } else if (facing === 'down') {
      px(g, 11, 5, 10, 8, SKIN); px(g, 10, 6, 12, 6, SKIN);
      px(g, 10, 4, 2, 5, HAIR); px(g, 20, 4, 2, 5, HAIR);
      // Eyes
      px(g, 13, 8, 2, 2, EYE); px(g, 17, 8, 2, 2, EYE);
      px(g, 14, 8, 1, 1, '#fff'); px(g, 18, 8, 1, 1, '#fff');
      // Eyebrows — solid dark, punchy at 32px
      px(g, 12, 7, 4, 1, 'rgba(40,25,15,0.5)');
      px(g, 16, 7, 4, 1, 'rgba(40,25,15,0.5)');
      // Nose shadow
      px(g, 15, 10, 2, 1, 'rgba(0,0,0,0.06)');
      px(g, 15, 11, 2, 1, MOUTH);
      // Ears
      px(g, 9, 7, 2, 3, SKIN); px(g, 21, 7, 2, 3, SKIN);
      px(g, 9, 7, 1, 3, 'rgba(0,0,0,0.06)');
    } else { // right (left is flipped)
      px(g, 12, 5, 9, 8, SKIN); px(g, 11, 6, 10, 6, SKIN);
      px(g, 11, 4, 4, 6, HAIR); px(g, 10, 5, 3, 4, HAIR);
      px(g, 18, 8, 2, 2, EYE); px(g, 19, 8, 1, 1, '#fff');
      px(g, 17, 7, 4, 1, 'rgba(40,25,15,0.5)'); // eyebrow — solid
      px(g, 19, 11, 1, 1, MOUTH); px(g, 21, 7, 2, 3, SKIN);
    }

    // ── Body — slate-blue jacket, clearly cool-toned against every warm NPC ──
    px(g, 10, 14, 12, 10, jacketBody); px(g, 11, 13, 10, 1, jacketBody);
    // Collar / neckline — slightly lighter than jacket so it reads as fabric fold
    px(g, 13, 13, 6, 2, '#7090b0');
    // Center zip — silver-blue, 2px wide so it's legible at phone scale
    px(g, 15, 14, 2, 9, jacketZip);
    px(g, 15, 14, 1, 9, 'rgba(255,255,255,0.10)'); // zip highlight
    // Shoulder top-light strip (single pixel row, brightest point)
    px(g, 10, 14, 12, 1, jacketLight);
    // Side volume shadows — punchy enough to read jacket shape at 32px
    px(g, 10, 15, 1, 8, jacketShadow);
    px(g, 21, 15, 1, 8, jacketShadow);
    // Chest panel crease (subtle vertical fold on each half)
    px(g, 13, 15, 1, 7, 'rgba(0,0,0,0.08)');
    px(g, 18, 15, 1, 7, 'rgba(0,0,0,0.08)');
    // ── Kangaroo pocket — dark enough to separate from jacket body at a glance ──
    px(g, 12, 19, 8, 4, jacketShadow);          // pocket base (deep navy)
    px(g, 13, 19, 6, 1, jacketBody);            // pocket top highlight (jacket colour peeks above seam)
    px(g, 12, 19, 1, 4, 'rgba(0,0,0,0.10)');   // left pocket wall shadow
    px(g, 19, 19, 1, 4, 'rgba(0,0,0,0.10)');   // right pocket wall shadow
    // Hem band — slightly darker, creates a clear bottom edge
    px(g, 10, 23, 12, 1, jacketShadow);
    // Ribbed hem texture
    px(g, 11, 23, 1, 1, 'rgba(255,255,255,0.04)');
    px(g, 13, 23, 1, 1, 'rgba(255,255,255,0.04)');
    px(g, 15, 23, 1, 1, 'rgba(255,255,255,0.04)');
    px(g, 17, 23, 1, 1, 'rgba(255,255,255,0.04)');
    px(g, 19, 23, 1, 1, 'rgba(255,255,255,0.04)');
    // Drawstrings (facing down only) — opaque enough to register
    if (facing === 'down') {
      px(g, 14, 14, 1, 4, 'rgba(160,190,220,0.30)');
      px(g, 17, 14, 1, 4, 'rgba(160,190,220,0.30)');
      px(g, 14, 18, 1, 1, 'rgba(140,170,200,0.20)'); // knot
      px(g, 17, 18, 1, 1, 'rgba(140,170,200,0.20)');
    }

    // ── Arms ──
    if (facing === 'down' || facing === 'up') {
      const s = walk ? 2 : 0;
      px(g, 7,  14-s, 3, 8, jacketBody);
      px(g, 22, 14+s, 3, 8, jacketBody);
      // Arm inner shadow (sleeve edge)
      px(g, 9,  14-s, 1, 8, jacketShadow);
      px(g, 22, 14+s, 1, 8, jacketShadow);
      // Arm outer highlight (top-light on sleeve crown)
      px(g, 7,  14-s, 1, 8, jacketLight);
      px(g, 24, 14+s, 1, 8, jacketLight);
      // Hands
      px(g, 7,  21-s, 3, 2, HAND); px(g, 22, 21+s, 3, 2, HAND);
      px(g, 7,  21-s, 3, 1, '#ecca9e');
    } else {
      const s = walk ? 3 : 0;
      px(g, 20, 14+s, 3, 7, jacketBody);
      px(g, 20, 14+s, 1, 7, jacketShadow);
      px(g, 22, 14+s, 1, 7, jacketLight);
      px(g, 20, 20+s, 3, 2, HAND);
    }

    // ── Legs — cool slate-grey clearly separates from dark shoes ──
    if (walk) {
      if (facing === 'down' || facing === 'up') {
        px(g, 11, 24, 4, 5, playerPants); px(g, 17, 24, 4, 5, playerPants);
        // Inner-leg highlight separates the two legs visually
        px(g, 14, 24, 1, 5, pantsLight);
        px(g, 17, 24, 1, 5, pantsLight);
        // Shoes — dark, with a bright toe-cap so they read at any scale
        px(g, 11, 29, 4, 2, SHOE); px(g, 17, 29, 4, 2, SHOE);
        px(g, 11, 29, 4, 1, '#3a3030'); // toe-cap highlight row
        px(g, 17, 29, 4, 1, '#3a3030');
        px(g, 11, 30, 4, 1, '#111'); px(g, 17, 30, 4, 1, '#111'); // sole
      } else {
        px(g, 12, 24, 4, 4, playerPants); px(g, 16, 24, 4, 5, playerPants);
        px(g, 11, 28, 4, 2, SHOE); px(g, 16, 29, 4, 2, SHOE);
        px(g, 11, 28, 4, 1, '#3a3030'); px(g, 16, 29, 4, 1, '#3a3030');
        px(g, 11, 29, 4, 1, '#111'); px(g, 16, 30, 4, 1, '#111');
      }
    } else {
      px(g, 12, 24, 4, 5, playerPants); px(g, 16, 24, 4, 5, playerPants);
      // Center gap: lighter stripe between legs (separation reads at 32px)
      px(g, 15, 24, 2, 5, pantsLight);
      px(g, 12, 29, 4, 2, SHOE); px(g, 16, 29, 4, 2, SHOE);
      px(g, 12, 29, 4, 1, '#3a3030'); px(g, 16, 29, 4, 1, '#3a3030');
      px(g, 12, 30, 4, 1, '#111'); px(g, 16, 30, 4, 1, '#111');
    }

    // Shoe tongue and lace detail (facing down)
    if (facing === 'down') {
      px(g, 13, 29, 2, 1, '#3a2a1a'); // left tongue
      px(g, 17, 29, 2, 1, '#3a2a1a'); // right tongue
      // Lace — cool white, visible
      px(g, 13, 29, 1, 1, 'rgba(200,215,230,0.22)');
      px(g, 18, 29, 1, 1, 'rgba(200,215,230,0.22)');
    }

    // ── Smart-watch — cool-toned screen, the visitor's device ──
    if (facing === 'down' && !walk) {
      px(g, 7, 20, 3, 1, '#1e2a3a');           // dark band (not warm)
      px(g, 8, 20, 1, 1, 'rgba(100,180,240,0.35)'); // blue screen glint — clearly tech
    }

    // Dark outline — slightly cooler than NPC outline to reinforce identity
    addOutline(c, '#0e1420');
    if (flip) {
      const f = makeCanvas(32, 32), fg = f.getContext('2d');
      fg.translate(32, 0); fg.scale(-1, 1); fg.drawImage(c, 0, 0); return f;
    }
    return c;
  }

  // ---- NPC sitting (32x32, upper body) — enhanced with shading ----
  function renderNpcSitting(npcId, facing) {
    const c = makeCanvas(32, 32), g = c.getContext('2d');
    const accent = NPC_COLORS[npcId] || '#aaa', isCruz = npcId === 'cruz';
    const bodyY = isCruz ? 12 : 14, bodyH = isCruz ? 12 : 10;
    // Stronger contrast: dark shadow, brighter highlight (+40 lighter vs old +20)
    const accentDark = darken(accent, 40), accentLight = darken(accent, -40);

    // ── Presence glow — NPCs emit a faint warm aura so they're visible in dark corners ──
    // Like body heat made visible. Cruz gets a stronger glow (he's the anchor).
    var glowA = isCruz ? 0.10 : 0.06;
    var glowR = isCruz ? 18 : 14;
    var presenceGlow = g.createRadialGradient(16, bodyY + 4, 2, 16, bodyY + 4, glowR);
    presenceGlow.addColorStop(0, 'rgba(220,180,120,' + glowA.toFixed(3) + ')');
    presenceGlow.addColorStop(0.4, 'rgba(220,180,120,' + (glowA * 0.3).toFixed(3) + ')');
    presenceGlow.addColorStop(1, 'rgba(220,180,120,0)');
    g.fillStyle = presenceGlow;
    g.fillRect(0, 0, 32, 32);

    // Body shadow on surface below
    g.fillStyle = 'rgba(0,0,0,0.10)';
    g.fillRect(9, bodyY + bodyH - 1, 14, 2);

    if (isCruz) {
      // Cruz: white shirt with colored apron/vest — bold contrast
      px(g, 10, bodyY, 12, bodyH, '#f8f2ea');
      // Vest/apron sides — use full accent saturation
      px(g, 10, bodyY, 4, bodyH, accent); px(g, 18, bodyY, 4, bodyH, accent);
      px(g, 14, bodyY, 4, 2, accent);
      // Shirt fold shadow
      px(g, 15, bodyY + 3, 1, bodyH - 4, 'rgba(0,0,0,0.08)');
      // Collar — bright white reads clearly
      px(g, 13, bodyY, 6, 1, '#ffffff');
      // Vest highlight — bright edge for silhouette
      px(g, 10, bodyY, 1, bodyH, accentLight);
      px(g, 21, bodyY, 1, bodyH, accentLight);
      // Dark line separating neck/skin from collar
      px(g, 13, bodyY - 1, 6, 1, 'rgba(0,0,0,0.18)');
    } else {
      // NPC clothing — full saturated accent, strong internal contrast
      px(g, 10, bodyY, 12, bodyH, accent);
      // Left shoulder bright highlight (catches overhead light)
      px(g, 10, bodyY, 5, 2, accentLight);
      // Center fold/seam shadow
      px(g, 15, bodyY + 2, 2, bodyH - 3, accentDark);
      // Right side in slight shadow
      px(g, 19, bodyY + 1, 3, bodyH - 1, accentDark);
      // Bottom hem shadow
      px(g, 10, bodyY + bodyH - 1, 12, 1, accentDark);
      // Dark 1px edge at top of clothing (skin-to-cloth boundary)
      px(g, 10, bodyY, 12, 1, 'rgba(0,0,0,0.20)');

      // Per-NPC outfit details
      if (npcId === 'polaris') {
        // Polaris: turtleneck collar — bold and distinctive
        px(g, 12, bodyY, 8, 3, accentDark); // thick turtleneck
        px(g, 12, bodyY, 8, 1, accentLight); // collar top bright edge
        // Small gold star pin on chest — more visible
        px(g, 11, bodyY + 4, 2, 2, '#f0c040');
        px(g, 11, bodyY + 4, 1, 1, '#ffe080'); // pin highlight
      } else if (npcId === 'nova') {
        // Nova: V-neck with necklace — large V opening reads at distance
        px(g, 13, bodyY, 6, 4, SKIN); // wide V-neck skin reveal
        px(g, 12, bodyY, 1, 3, accentDark); // V-neck left edge shadow
        px(g, 19, bodyY, 1, 3, accentDark); // V-neck right edge shadow
        // Necklace — brighter so it reads
        g.strokeStyle = 'rgba(220,200,120,0.6)'; g.lineWidth = 0.6;
        g.beginPath();
        g.moveTo(13, bodyY + 2);
        g.quadraticCurveTo(16, bodyY + 5, 19, bodyY + 2);
        g.stroke();
        // Pendant — solid bright dot
        g.fillStyle = '#e03030';
        g.fillRect(15.5, bodyY + 4, 1, 1);
      } else if (npcId === 'mira') {
        // Mira: cardigan with prominent buttons — buttons are the identifier
        px(g, 15, bodyY + 1, 2, bodyH - 2, accentDark); // center placket
        // Three chunky buttons — bright white, clearly visible
        px(g, 15, bodyY + 2, 2, 2, '#ffffff');
        px(g, 15, bodyY + 5, 2, 2, '#ffffff');
        px(g, 15, bodyY + 8, 2, 2, '#ffffff');
        // Inner shirt peek — contrasting warm color
        px(g, 13, bodyY, 6, 2, '#f8d090');
      } else if (npcId === 'rigel') {
        // Rigel: hoodie — thick hood edge and kangaroo pocket
        px(g, 11, bodyY, 10, 3, accentDark); // wide thick hood brim
        px(g, 11, bodyY, 10, 1, 'rgba(255,255,255,0.15)'); // hood rim highlight
        // Drawstrings — brighter, readable
        g.strokeStyle = 'rgba(255,255,255,0.40)'; g.lineWidth = 0.6;
        g.beginPath(); g.moveTo(14, bodyY + 3); g.lineTo(13, bodyY + 6); g.stroke();
        g.beginPath(); g.moveTo(18, bodyY + 3); g.lineTo(19, bodyY + 6); g.stroke();
        // Kangaroo pocket — contrasting color band
        px(g, 11, bodyY + bodyH - 5, 10, 4, accentDark);
        px(g, 11, bodyY + bodyH - 5, 10, 1, 'rgba(255,255,255,0.12)'); // pocket top edge
      }
    }

    // Arms — sleeve color (accent) with skin hands
    var armC = accent;
    px(g, 6, bodyY + 1, 4, 6, armC);
    px(g, 22, bodyY + 1, 4, 6, armC);
    // Arm inner edge shadow
    px(g, 9, bodyY + 1, 1, 6, 'rgba(0,0,0,0.12)');
    px(g, 22, bodyY + 1, 1, 6, 'rgba(0,0,0,0.12)');
    // Hands — warm skin tone, clear contrast against table
    px(g, 6, bodyY + 6, 4, 2, HAND); px(g, 22, bodyY + 6, 4, 2, HAND);
    px(g, 6, bodyY + 6, 4, 1, '#f0c898'); // hand highlight
    // Dark edge between sleeve and hand
    px(g, 6, bodyY + 6, 4, 1, 'rgba(0,0,0,0.12)');

    // Head
    const hY = isCruz ? 1 : 3;
    // Per-NPC hair — vivid, high-saturation, DISTINCT silhouettes at 32px
    var NPC_HAIR = {
      cruz:    '#1a0e08',  // near-black espresso — authority and contrast
      polaris: '#0a1e3a',  // deep midnight blue — intellectual cool
      nova:    '#c03018',  // bold auburn-red — fiery, unmistakable
      mira:    '#5a1870',  // vivid plum-purple — mysterious standout
      rigel:   '#c8a040',  // warm golden-sandy — casual brightness
    };
    var hairC = NPC_HAIR[npcId] || HAIR;
    // Hair shine: lighter (not darker) version for contrast
    var hairLight = darken(hairC, -30);
    var hairDark  = darken(hairC, 30);

    // Head shadow on body (stronger drop shadow = more depth)
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(11, hY + 11, 10, 2);

    // ── Face — painted BEFORE hair so hair overlaps cleanly ──
    px(g, 11, hY + 3, 10, 8, SKIN); px(g, 10, hY + 4, 12, 6, SKIN);
    // Cheek warmth — slightly more visible
    g.fillStyle = 'rgba(220,140,110,0.22)';
    g.fillRect(10, hY + 7, 3, 2); g.fillRect(19, hY + 7, 3, 2);

    // ── Hair base — TALLER and WIDER mass for strong silhouette ──
    // 4px tall instead of 3px; side sideburns are painted as part of base
    px(g, 10, hY, 12, 4, hairC);   // full-width cap (12px wide, 4px tall)
    px(g, 9,  hY + 1, 14, 3, hairC); // extra-wide crown (+1px each side)
    // Hair shine — top center
    px(g, 13, hY, 6, 1, hairLight);
    px(g, 13, hY + 1, 4, 1, 'rgba(255,255,255,0.12)');

    // ── Per-NPC hair style — each is a DISTINCT SILHOUETTE ──
    if (npcId === 'cruz') {
      // Cruz: neat, tight, professional — no extras, clean edge defines authority
      px(g, 10, hY + 3, 12, 1, hairDark); // clean hairline
    } else if (npcId === 'polaris') {
      // Polaris: swept-back sides — hair longer on right (reading direction), intellectual look
      px(g, 9,  hY + 2, 2, 5, hairC); // left side panel
      px(g, 21, hY + 2, 2, 7, hairC); // right side longer sweep
      px(g, 21, hY + 8, 2, 1, hairLight); // tip highlight
    } else if (npcId === 'nova') {
      // Nova: long flowing hair past shoulders — tallest silhouette (unmistakable)
      px(g, 8, hY + 2, 3, 9, hairC);   // left curtain, thick
      px(g, 21, hY + 2, 3, 9, hairC);  // right curtain, thick
      px(g, 8, hY + 9, 3, 1, hairLight); // tip shimmer left
      px(g, 21, hY + 9, 3, 1, hairLight); // tip shimmer right
      // Wavy edge hints
      px(g, 8,  hY + 5, 1, 2, hairDark);
      px(g, 23, hY + 5, 1, 2, hairDark);
    } else if (npcId === 'mira') {
      // Mira: heavy swept bangs — asymmetric, covers half forehead
      px(g, 9, hY + 2, 9, 3, hairC);  // thick bang mass sweeping left
      px(g, 9, hY + 4, 5, 1, hairC);  // bang drape continues lower-left
      px(g, 9, hY + 2, 9, 1, hairLight); // bang top highlight
      px(g, 9, hY + 5, 3, 1, hairDark);  // bang tip shadow
    } else if (npcId === 'rigel') {
      // Rigel: spiky/messy — spikes poke above hairline, chaotic energy
      px(g, 11, hY - 2, 3, 3, hairC); // left spike
      px(g, 15, hY - 3, 3, 4, hairC); // center taller spike
      px(g, 19, hY - 2, 3, 3, hairC); // right spike
      px(g, 12, hY - 2, 1, 1, hairLight); // spike tips catch light
      px(g, 16, hY - 3, 1, 1, hairLight);
      px(g, 20, hY - 2, 1, 1, hairLight);
    }

    // Ears — painted after hair sides so ears peek through properly
    px(g, 8, hY + 5, 2, 3, SKIN); px(g, 22, hY + 5, 2, 3, SKIN);
    // Ear shadow
    px(g, 8, hY + 5, 1, 3, 'rgba(0,0,0,0.08)');
    // Inner ear hint
    px(g, 9, hY + 6, 1, 1, 'rgba(200,120,100,0.20)');
    px(g, 22, hY + 6, 1, 1, 'rgba(200,120,100,0.20)');

    if (facing === 'down' || facing === undefined) {
      // Sideburns — painted over face, connects hair to ears
      px(g, 9, hY + 3, 2, 5, hairC); px(g, 21, hY + 3, 2, 5, hairC);
      // Eyes — per-NPC eye color, slightly larger (2x2) for readability
      var eyeColors = { cruz: '#0a0a0a', polaris: '#1a3a6a', nova: '#5a1a0a', mira: '#1a3a1a', rigel: '#2a2010' };
      var eyeC = eyeColors[npcId] || EYE;
      px(g, 12, hY + 6, 2, 2, eyeC); px(g, 18, hY + 6, 2, 2, eyeC);
      // White reflection dot — keeps eyes readable
      px(g, 13, hY + 6, 1, 1, 'rgba(255,255,255,0.9)'); px(g, 19, hY + 6, 1, 1, 'rgba(255,255,255,0.9)');
      // Eyebrows — solid dark, not semi-transparent (readability at distance)
      g.fillStyle = hairDark; g.globalAlpha = 0.75;
      g.fillRect(11, hY + 5, 4, 1);
      g.fillRect(17, hY + 5, 4, 1);
      g.globalAlpha = 1;
      // Mouth — slightly wider
      px(g, 14, hY + 9, 4, 1, MOUTH);
      // Nose hint
      px(g, 15, hY + 8, 2, 1, 'rgba(0,0,0,0.06)');
    } else if (facing === 'left') {
      // Side hair bulk — visible right side back-sweep
      px(g, 19, hY + 2, 4, 6, hairC);
      var eyeC2 = { cruz: '#0a0a0a', polaris: '#1a3a6a', nova: '#5a1a0a', mira: '#1a3a1a', rigel: '#2a2010' }[npcId] || EYE;
      px(g, 11, hY + 6, 2, 2, eyeC2); px(g, 12, hY + 6, 1, 1, 'rgba(255,255,255,0.9)');
      g.fillStyle = hairDark; g.globalAlpha = 0.75; g.fillRect(10, hY + 5, 4, 1); g.globalAlpha = 1;
      px(g, 12, hY + 9, 2, 1, MOUTH);
    } else if (facing === 'right') {
      // Side hair bulk — visible left side back-sweep
      px(g, 9, hY + 2, 4, 6, hairC);
      var eyeC3 = { cruz: '#0a0a0a', polaris: '#1a3a6a', nova: '#5a1a0a', mira: '#1a3a1a', rigel: '#2a2010' }[npcId] || EYE;
      px(g, 19, hY + 6, 2, 2, eyeC3); px(g, 20, hY + 6, 1, 1, 'rgba(255,255,255,0.9)');
      g.fillStyle = hairDark; g.globalAlpha = 0.75; g.fillRect(18, hY + 5, 4, 1); g.globalAlpha = 1;
      px(g, 19, hY + 9, 2, 1, MOUTH);
    } else { // up — back of head
      // Back-of-head: full hair coverage, per-NPC style readable from behind
      // Base hair mass (full coverage)
      px(g, 10, hY + 2, 12, 8, hairC); px(g, 9, hY + 3, 14, 6, hairC);
      // Crown volume (lighter center where hair radiates from)
      px(g, 13, hY + 2, 6, 2, hairLight);
      // Crown whorl hint
      g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 0.5;
      g.beginPath(); g.arc(16, hY + 4, 2.5, 0.5, Math.PI * 1.5); g.stroke();
      // Layered hair depth bands
      px(g, 10, hY + 5, 12, 1, hairDark);  // mid-layer shadow
      px(g, 9,  hY + 7, 14, 1, hairDark);  // lower layer shadow
      // Side volume edges
      px(g, 9,  hY + 3, 1, 5, hairDark);
      px(g, 22, hY + 3, 1, 5, hairDark);
      // Nape of neck
      px(g, 13, hY + 9, 6, 2, SKIN);
      px(g, 13, hY + 9, 6, 1, 'rgba(0,0,0,0.10)'); // nape shadow from hair

      // Per-NPC back-of-head detail
      if (npcId === 'nova') {
        // Nova: long hair flowing past body — wide and long curtains
        px(g, 7, hY + 5, 3, 7, hairC);
        px(g, 22, hY + 5, 3, 7, hairC);
        px(g, 7,  hY + 11, 3, 1, hairLight); // tip highlight
        px(g, 22, hY + 11, 3, 1, hairLight);
      } else if (npcId === 'rigel') {
        // Rigel: spiky silhouette visible from behind
        px(g, 11, hY,     3, 3, hairC);
        px(g, 15, hY - 1, 4, 4, hairC); // center spike tallest
        px(g, 19, hY,     3, 3, hairC);
        px(g, 16, hY - 1, 2, 1, hairLight); // center tip highlight
      } else if (npcId === 'mira') {
        // Mira: prominent gold hair clip/pin visible on back
        px(g, 17, hY + 4, 3, 2, '#e0b820'); // gold clip bar
        px(g, 17, hY + 4, 3, 1, '#ffe060'); // clip shine
        // Hair slightly asymmetric from clip pulling it
        px(g, 9, hY + 4, 2, 6, hairC); // left side slightly fuller
      } else if (npcId === 'polaris') {
        // Polaris: neat side part visible from behind
        px(g, 16, hY + 2, 1, 5, hairDark); // part line
        px(g, 15, hY + 2, 1, 3, hairLight); // highlight beside part
      } else if (npcId === 'cruz') {
        // Cruz: clean fade — tight neckline, tapers
        px(g, 11, hY + 7, 10, 2, hairDark); // tight neckline fade
        px(g, 12, hY + 9, 8, 1, SKIN);      // clean skin showing through fade
      }
      // Ear tips peeking out from sides
      px(g, 8, hY + 5, 2, 2, SKIN); px(g, 22, hY + 5, 2, 2, SKIN);
      px(g, 8, hY + 5, 1, 2, 'rgba(0,0,0,0.06)'); // ear shadow
    }

    // Desk item (enhanced with detail)
    var iy = bodyY + bodyH - 2, t = NPC_ITEMS[npcId], ix = 24;
    if (t === 'register') {
      // Cash register body
      px(g, ix - 2, iy, 6, 4, '#555');
      px(g, ix - 2, iy, 6, 1, '#666'); // top edge
      // Screen (green LCD)
      px(g, ix - 1, iy - 1, 4, 1, '#1a3a1a');
      px(g, ix, iy - 1, 2, 1, '#3a8a3a'); // numbers glow
      // Buttons row
      px(g, ix - 1, iy + 1, 1, 1, '#888');
      px(g, ix + 1, iy + 1, 1, 1, '#888');
      px(g, ix + 3, iy + 1, 1, 1, '#c44'); // red total button
      // Cash drawer line
      px(g, ix - 2, iy + 3, 6, 1, '#444');
    } else if (t === 'book') {
      // Hardcover book (open)
      px(g, ix - 1, iy, 7, 5, '#2980b9');
      // Spine
      px(g, ix + 2, iy, 1, 5, '#1a5276');
      // Pages (cream)
      px(g, ix, iy + 1, 2, 3, '#f5e8d0');
      px(g, ix + 3, iy + 1, 2, 3, '#f5e8d0');
      // Text lines
      g.fillStyle = 'rgba(60,40,20,0.15)';
      g.fillRect(ix, iy + 1.5, 2, 0.5);
      g.fillRect(ix + 3, iy + 2, 2, 0.5);
      // Cover highlight
      px(g, ix - 1, iy, 7, 1, '#3498db');
      // Bookmark ribbon
      px(g, ix + 4, iy - 1, 1, 2, '#c0392b');
    } else if (t === 'laptop') {
      // Laptop base (keyboard)
      px(g, ix - 1, iy + 1, 6, 3, '#3a3a3a');
      px(g, ix - 1, iy + 1, 6, 1, '#4a4a4a'); // keyboard top edge
      // Key grid hint
      g.fillStyle = 'rgba(80,80,80,0.3)';
      g.fillRect(ix, iy + 2, 4, 1);
      // Screen
      px(g, ix - 1, iy - 2, 6, 3, '#1a2a3a');
      // Code on screen
      g.fillStyle = 'rgba(80,200,120,0.3)';
      g.fillRect(ix, iy - 1, 3, 1);
      g.fillStyle = 'rgba(100,160,255,0.25)';
      g.fillRect(ix, iy, 2, 1);
      // Screen bezel
      g.strokeStyle = '#555'; g.lineWidth = 0.3;
      g.strokeRect(ix - 1, iy - 2, 6, 3);
      // Screen glow on face
      g.fillStyle = 'rgba(80,200,120,0.03)';
      g.fillRect(ix - 4, iy - 3, 8, 4);
    } else if (t === 'notebook') {
      // Moleskine notebook
      px(g, ix, iy, 5, 5, '#f5e6ca');
      // Red bookmark ribbon
      px(g, ix, iy, 1, 5, '#c0392b');
      // Elastic band — lineWidth 1.0 (was 0.4, sub-pixel drops on mobile)
      g.strokeStyle = 'rgba(212,160,64,0.35)'; // was '#d4a040' (fully opaque but invisible at 0.4px)
      g.lineWidth = 1.0;
      g.beginPath(); g.moveTo(ix + 2.5, iy); g.lineTo(ix + 2.5, iy + 5); g.stroke();
      // Shadow strip — 1px warm brown gives notebook a spine depth
      g.strokeStyle = 'rgba(80,40,10,0.18)';
      g.lineWidth = 1.0;
      g.beginPath(); g.moveTo(ix + 3.5, iy); g.lineTo(ix + 3.5, iy + 5); g.stroke();
      // Handwriting lines
      g.fillStyle = 'rgba(60,40,20,0.12)';
      g.fillRect(ix + 1, iy + 1, 3, 0.5);
      g.fillRect(ix + 1, iy + 2.5, 2, 0.5);
      // Pen beside notebook
      px(g, ix + 5, iy + 1, 1, 3, '#222');
      px(g, ix + 5, iy + 1, 1, 1, '#b8860b'); // pen clip
    } else if (t === 'phone') {
      // Smartphone (face up)
      px(g, ix + 1, iy, 3, 5, '#222');
      // Screen
      px(g, ix + 1, iy + 1, 3, 3, '#3a6a9a');
      // Notification bar
      px(g, ix + 1, iy + 1, 3, 1, '#4a8aba');
      // Home button dot
      px(g, ix + 2, iy + 4, 1, 1, '#333');
      // Screen glow
      g.fillStyle = 'rgba(60,120,180,0.03)';
      g.fillRect(ix - 1, iy - 1, 6, 7);
    }
    // ── Coffee cup beside each NPC (everyone has a drink at the cafe) ──
    if (t !== 'register') { // Cruz behind counter doesn't need a cup on table
      var cupX = ix - 6, cupY = iy + 2;
      // Cup body (small ceramic)
      g.fillStyle = '#f0e8d0';
      g.fillRect(cupX, cupY, 3, 2);
      // Coffee inside
      g.fillStyle = '#3a2210';
      g.fillRect(cupX + 0.3, cupY + 0.3, 2.4, 0.8);
      // Cup handle (tiny arc)
      g.strokeStyle = '#e0d4b8'; g.lineWidth = 0.4;
      g.beginPath(); g.arc(cupX - 0.5, cupY + 1, 0.8, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
      // Cup rim highlight
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fillRect(cupX, cupY, 3, 0.3);
      // Steam wisps (2 tiny curving lines rising from cup)
      // lineWidth ≥ 1.0 so mobile displays don't drop sub-pixel strokes
      // alpha 0.45 — warm ivory tint matches pendant-lamp ambience
      g.strokeStyle = 'rgba(230,220,200,0.45)'; g.lineWidth = 1.0;
      g.beginPath();
      g.moveTo(cupX + 1, cupY);
      g.quadraticCurveTo(cupX + 0.5, cupY - 1.5, cupX + 1.5, cupY - 2.5);
      g.stroke();
      g.beginPath();
      g.moveTo(cupX + 2, cupY);
      g.quadraticCurveTo(cupX + 2.5, cupY - 1, cupX + 2, cupY - 2);
      g.stroke();
    }

    // ── Enhanced screen glow on NPC face (laptop/phone) ──
    if (t === 'laptop') {
      // Stronger blue-green glow reflected on face and body
      var lgx = ix + 1, lgy = iy - 4;
      var screenGlow = g.createRadialGradient(lgx, lgy + 2, 0, lgx, lgy, 8);
      screenGlow.addColorStop(0, 'rgba(80,200,120,0.06)');
      screenGlow.addColorStop(0.5, 'rgba(80,180,120,0.02)');
      screenGlow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = screenGlow;
      g.fillRect(lgx - 6, lgy - 4, 14, 10);
    }
    if (t === 'phone') {
      // Phone screen glow on chin/chest area
      var pgx = ix + 2, pgy = iy - 2;
      var phoneGlow = g.createRadialGradient(pgx, pgy, 0, pgx, pgy, 5);
      phoneGlow.addColorStop(0, 'rgba(60,120,180,0.05)');
      phoneGlow.addColorStop(1, 'rgba(60,120,180,0)');
      g.fillStyle = phoneGlow;
      g.fillRect(pgx - 4, pgy - 3, 8, 6);
    }

    // Dark outline — makes NPC pop from background (Identity V style)
    addOutline(c, '#1a0e06');
    return c;
  }

  // ---- Cruz wiping cup (idle variant) ----
  // One hand holds cup, other hand wipes — subtle 2-frame loop
  function renderCruzWipe(frame) {
    const c = makeCanvas(32, 32), g = c.getContext('2d');
    // Vest: deeper amber body, punchy highlight, strong shadow — reads clearly at 32px
    const accent = '#e8920f', accentDark = '#7a4800', accentLight = '#ffb930';
    const bodyY = 12, bodyH = 12;

    // ── Cruz presence glow — warm amber pool from the pendant lamp directly above ──
    var wipeGlow = g.createRadialGradient(16, bodyY + 4, 2, 16, bodyY + 4, 18);
    wipeGlow.addColorStop(0, 'rgba(240,190,100,0.18)');
    wipeGlow.addColorStop(0.4, 'rgba(230,175,90,0.07)');
    wipeGlow.addColorStop(1, 'rgba(220,160,80,0)');
    g.fillStyle = wipeGlow;
    g.fillRect(0, 0, 32, 32);

    // ── Pendant lamp catch — warm top-light strip on hair & shoulder ──
    // The lamp hangs above; Cruz gets a golden crown of light
    var lampGlow = g.createLinearGradient(8, 0, 24, 14);
    lampGlow.addColorStop(0, 'rgba(255,210,120,0.22)');
    lampGlow.addColorStop(0.5, 'rgba(255,200,100,0.08)');
    lampGlow.addColorStop(1, 'rgba(255,190,80,0)');
    g.fillStyle = lampGlow;
    g.fillRect(8, 0, 16, 14);

    // Body shadow on counter surface
    g.fillStyle = 'rgba(0,0,0,0.10)';
    g.fillRect(9, bodyY + bodyH - 1, 14, 2);

    // Body — crisp white shirt, visible between vest panels
    px(g, 10, bodyY, 12, bodyH, '#f0ebe5');
    // Center shirt front (between vest halves) — slightly warmer in lamp light
    px(g, 14, bodyY, 4, bodyH, '#f8f2e8');
    // Shirt fold seam
    px(g, 15, bodyY + 3, 1, bodyH - 4, 'rgba(0,0,0,0.06)');
    // Collar (visible at neckline)
    px(g, 13, bodyY, 6, 2, '#ece6de');
    px(g, 14, bodyY, 4, 1, '#fff'); // collar top highlight

    // Vest left panel
    px(g, 10, bodyY, 4, bodyH, accent);
    px(g, 10, bodyY, 2, bodyH, accentLight); // left edge lamp catch
    px(g, 13, bodyY, 1, bodyH, accentDark);  // right-edge inner shadow
    // Vest right panel
    px(g, 18, bodyY, 4, bodyH, accent);
    px(g, 21, bodyY, 1, bodyH, accentDark);  // outer edge shadow
    // Vest top yoke (connects shoulders)
    px(g, 14, bodyY, 4, 2, accent);
    px(g, 14, bodyY, 4, 1, accentLight); // lamp-lit top edge
    // Button row on left vest panel (3 tiny dark dots)
    px(g, 11, bodyY + 3, 1, 1, accentDark); px(g, 11, bodyY + 6, 1, 1, accentDark);
    px(g, 11, bodyY + 9, 1, 1, accentDark);

    // Right arm resting on counter
    px(g, 22, bodyY+1, 3, 6, accent);
    px(g, 22, bodyY+1, 1, 6, accentDark); // arm inner shadow
    px(g, 24, bodyY+1, 1, 6, accentLight); // arm outer lamp catch
    px(g, 22, bodyY+6, 3, 2, HAND);
    px(g, 22, bodyY+6, 3, 1, '#ecca9e'); // hand highlight

    // Wiping arm — offset between frames (frame 1 = mid-stroke, shifted up)
    var wipeOff = frame === 0 ? 0 : -2;
    px(g, 7, bodyY+1+wipeOff, 3, 6, accent);
    px(g, 9, bodyY+1+wipeOff, 1, 6, accentDark); // arm inner shadow
    px(g, 7, bodyY+6+wipeOff, 3, 2, HAND);
    px(g, 7, bodyY+6+wipeOff, 3, 1, '#ecca9e'); // hand highlight (was missing)

    // ── Cup being wiped — bolder, 6px wide, reads as a cup at phone distance ──
    var cupY = bodyY + 2 + wipeOff;
    // Cup body (warm brown ceramic, wider for readability)
    px(g, 3, cupY + 1, 6, 5, '#8a6650');
    // Cup interior (dark coffee visible inside top)
    px(g, 4, cupY + 1, 4, 2, '#2e1a0a');
    // Cup rim highlight (bright ceramic edge)
    px(g, 3, cupY + 1, 6, 1, '#c09a7a');
    // Cup base (slightly wider, grounds it)
    px(g, 3, cupY + 5, 6, 1, '#6a4e3a');
    // Cup handle (right side — single 2px stroke, dark ceramic tone, no sub-pixel overlay)
    g.strokeStyle = '#6a4e3a'; g.lineWidth = 2;
    g.beginPath(); g.arc(10, cupY + 3, 2, -Math.PI * 0.55, Math.PI * 0.55); g.stroke();
    // Cup specular glint (2px wide — visible on phone)
    px(g, 4, cupY + 2, 2, 2, 'rgba(255,255,255,0.18)');

    // ── Bar towel — integer pixel rows only, bold stripes that read at scale ──
    var towY = cupY + 4;
    px(g, 4, towY,     5, 1, '#f0e8dc'); // top highlight row
    px(g, 4, towY + 1, 5, 1, '#3c5a8c'); // bold blue stripe (opaque)
    px(g, 4, towY + 2, 5, 1, '#e8ddd0'); // cream body
    px(g, 4, towY + 3, 5, 1, '#c03228'); // bold red stripe (opaque)
    px(g, 4, towY + 4, 5, 1, '#d8ccc0'); // shadow row at bottom
    // Fold crease (vertical) — adds 3D cloth sense
    px(g, 6, towY + 1, 1, 3, 'rgba(0,0,0,0.10)');
    // Towel hanging tab below hand
    px(g, 4, towY + 5, 3, 2, '#e4d8cc');
    px(g, 4, towY + 5, 3, 1, '#3c5a8c'); // stripe continues on hanging tab

    // ── Head ──
    var hY = 1;
    // Head shadow cast down onto collar
    g.fillStyle = 'rgba(0,0,0,0.07)';
    g.fillRect(11, hY + 11, 10, 2);
    // Face
    px(g, 11, hY+3, 10, 8, SKIN); px(g, 10, hY+4, 12, 6, SKIN);
    // Pendant lamp top-light — golden warmth on forehead and cheekbones
    g.fillStyle = 'rgba(255,210,140,0.18)';
    g.fillRect(12, hY + 3, 8, 3); // forehead catch
    // Cheek warmth (blush from focus, slightly stronger)
    g.fillStyle = 'rgba(220,150,120,0.16)';
    g.fillRect(10, hY + 7, 3, 2); g.fillRect(19, hY + 7, 3, 2);

    // Hair — lamp light creates a golden crown shimmer on top
    px(g, 11, hY, 10, 3, HAIR); px(g, 10, hY+1, 12, 2, HAIR);
    px(g, 12, hY, 8, 1, '#6a4a30');     // lamp-lit top of hair (lighter brown)
    px(g, 14, hY, 4, 1, 'rgba(255,210,140,0.20)'); // golden lamp sheen
    // Sideburns
    px(g, 10, hY+2, 2, 4, HAIR); px(g, 20, hY+2, 2, 4, HAIR);
    // Ears
    px(g, 9, hY+5, 2, 3, SKIN); px(g, 21, hY+5, 2, 3, SKIN);
    px(g, 9, hY+5, 1, 3, 'rgba(0,0,0,0.06)');

    // Eyes — looking down at cup, slightly squinted in concentration
    px(g, 13, hY+7, 2, 1, EYE); px(g, 17, hY+7, 2, 1, EYE); // squinted: 1px tall not 2
    px(g, 14, hY+7, 1, 1, '#fff'); px(g, 18, hY+7, 1, 1, '#fff');
    // Eyebrows — drawn together slightly (focused frown)
    px(g, 12, hY+6, 4, 1, HAIR);   // left brow — solid dark, not semitransparent
    px(g, 16, hY+6, 4, 1, HAIR);   // right brow
    px(g, 15, hY+6, 2, 1, '#1a0e06'); // inner brow pull (furrow)
    // Nose bridge shadow (from downward gaze)
    px(g, 15, hY+9, 2, 1, 'rgba(0,0,0,0.06)');
    // Slight focused press of lips (not a smile — he's concentrating)
    px(g, 14, hY+10, 4, 1, MOUTH);
    px(g, 15, hY+10, 2, 1, 'rgba(180,100,80,0.20)'); // center lip shadow

    addOutline(c, '#1a0e06');
    return c;
  }

  // ---- Rain drops on window glass ----
  function renderRainDrop() {
    const c = makeCanvas(4, 12), g = c.getContext('2d');
    // Tapered raindrop: bright head fading to thin tail, smoother gradient
    var grd = g.createLinearGradient(0, 0, 0, 12);
    grd.addColorStop(0, 'rgba(210,230,250,0.65)');
    grd.addColorStop(0.2, 'rgba(190,215,240,0.5)');
    grd.addColorStop(0.5, 'rgba(170,200,230,0.3)');
    grd.addColorStop(0.8, 'rgba(150,185,215,0.12)');
    grd.addColorStop(1, 'rgba(140,180,210,0)');
    g.fillStyle = grd;
    // Wider head (3px) tapering smoothly to 1px tail
    g.fillRect(0, 0, 3, 2);   // head (widest)
    g.fillRect(1, 2, 2, 3);   // upper body
    g.fillRect(1, 5, 2, 3);   // lower body
    g.fillRect(2, 8, 1, 4);   // tail (thinnest)
    // Bright specular at very top
    g.fillStyle = 'rgba(240,250,255,0.6)';
    g.fillRect(0, 0, 1, 1);
    // Refraction highlight (middle of drop)
    g.fillStyle = 'rgba(220,240,255,0.15)';
    g.fillRect(1, 3, 1, 2);
    // Water meniscus edges (rounded feel)
    g.fillStyle = 'rgba(200,230,250,0.2)';
    g.fillRect(0, 1, 1, 1);
    g.fillRect(2, 0, 1, 1);
    return c;
  }

  // ---- Chair (32x32, top-down RPG angle) ----
  function renderChair() {
    const c = makeCanvas(32, 32), g = c.getContext('2d');

    // ── Bentwood cafe chair (side view, warm wood tones) ──
    var dark = '#4a3020', mid = '#6d4c3d', light = '#8d6e63', highlight = '#a08060';

    // ── Back legs (behind seat) ──
    px(g, 8, 16, 2, 14, dark);  // left back leg
    px(g, 22, 16, 2, 14, dark); // right back leg
    // Leg highlights
    px(g, 8, 16, 1, 14, mid);
    px(g, 22, 16, 1, 14, mid);
    // Feet (wider base)
    px(g, 7, 29, 4, 1, mid); px(g, 21, 29, 4, 1, mid);

    // ── Backrest (curved bentwood, signature cafe chair detail) ──
    // Outer frame posts (two vertical members rising from seat)
    px(g, 9, 6, 2, 12, mid);   // left post
    px(g, 21, 6, 2, 12, mid);  // right post
    // Post highlights
    px(g, 9, 6, 1, 12, light);
    px(g, 21, 6, 1, 12, light);

    // Top rail (curved cross-piece)
    px(g, 9, 6, 14, 2, mid);
    px(g, 10, 7, 12, 1, dark);  // shadow on bottom edge
    px(g, 10, 6, 12, 1, highlight); // light on top edge

    // Middle rail (horizontal support)
    px(g, 10, 12, 12, 2, dark);
    px(g, 10, 12, 12, 1, mid);

    // ── Decorative spindles between top rail and middle rail ──
    // Three vertical turned spindles (classic café Thonet style)
    var spindleX = [13, 16, 19];
    for (var sp = 0; sp < spindleX.length; sp++) {
      var spx = spindleX[sp];
      // Spindle body (narrow turned wood)
      px(g, spx, 8, 1, 4, dark);
      // Spindle highlight (catches light on left edge)
      g.fillStyle = 'rgba(160,128,96,0.25)';
      g.fillRect(spx, 8, 1, 4);
      // Bulge at center (lathe-turned detail) — slightly wider pixel
      px(g, spx - 0.5, 9.5, 2, 1, mid);
    }

    // ── Wood grain on backrest posts ──
    g.fillStyle = 'rgba(50,30,15,0.18)';
    // Left post grain (1px fillRect — stable on mobile)
    g.fillRect(9, 7, 1, 10);
    // Right post grain
    g.fillRect(21, 7, 1, 10);
    // Top rail grain (horizontal)
    g.fillRect(11, 6, 10, 1);

    // ── Seat (round cushion, slight 3D) ──
    // Seat frame
    px(g, 7, 18, 18, 4, mid);
    // Cushion top (leather/fabric, slightly lighter center)
    px(g, 8, 18, 16, 3, '#7a5a48');
    px(g, 10, 19, 12, 1, light); // center highlight
    // Seat edge shadow (bottom)
    px(g, 7, 21, 18, 1, dark);
    // Seat edge highlight (top)
    px(g, 8, 18, 16, 1, highlight);

    // ── Worn patina on seat center (years of sitting) ──
    var patina = g.createRadialGradient(16, 19, 0, 16, 19, 6);
    patina.addColorStop(0, 'rgba(140,110,80,0.12)'); // lighter worn center
    patina.addColorStop(0.6, 'rgba(140,110,80,0.04)');
    patina.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = patina; g.fillRect(8, 18, 16, 3);

    // ── Upholstery tack studs (brass dots along seat edge) ──
    g.fillStyle = 'rgba(180,150,80,0.25)';
    for (var ti = 0; ti < 6; ti++) {
      g.beginPath(); g.arc(10 + ti * 2.4, 18.3, 0.4, 0, Math.PI * 2); g.fill();
    }

    // ── Front legs ──
    px(g, 8, 22, 2, 8, dark);   // left front leg
    px(g, 22, 22, 2, 8, dark);  // right front leg
    px(g, 8, 22, 1, 8, mid);    // highlights
    px(g, 22, 22, 1, 8, mid);
    // Front feet (wider, with floor pads)
    px(g, 7, 29, 4, 1, mid); px(g, 21, 29, 4, 1, mid);
    // Rubber/felt pads on feet (dark dots)
    g.fillStyle = 'rgba(30,20,10,0.3)';
    g.fillRect(8, 29.5, 2, 0.5); g.fillRect(22, 29.5, 2, 0.5);

    // ── Cross brace (H-stretcher between legs) ──
    px(g, 10, 26, 12, 1, dark);
    px(g, 10, 26, 12, 1, 'rgba(109,76,61,0.5)');
    // Brace joint pegs (dowel dots at intersections)
    g.fillStyle = 'rgba(100,70,45,0.3)';
    g.beginPath(); g.arc(10, 26.5, 0.5, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(22, 26.5, 0.5, 0, Math.PI * 2); g.fill();

    // ── Subtle wood grain on seat ──
    g.fillStyle = 'rgba(60,40,25,0.20)';
    g.fillRect(9, 19, 14, 1);
    g.fillRect(9, 20, 14, 1);

    // ── Leg grain lines (vertical, subtle) ──
    g.fillStyle = 'rgba(50,30,15,0.18)';
    g.fillRect(9, 22, 1, 7);
    g.fillRect(23, 22, 1, 7);

    // ── Contact shadows at leg bases (soft ellipses grounding feet on floor) ──
    // Four leg feet: left-back, left-front, right-back, right-front
    // All land near y=30; front legs cast slightly larger shadows (closer to viewer)
    var legShadows = [
      { cx: 9,  cy: 30.5, rx: 3.0, ry: 1.2 }, // left back foot
      { cx: 9,  cy: 31.0, rx: 3.5, ry: 1.4 }, // left front foot (larger — closer)
      { cx: 23, cy: 30.5, rx: 3.0, ry: 1.2 }, // right back foot
      { cx: 23, cy: 31.0, rx: 3.5, ry: 1.4 }, // right front foot (larger — closer)
    ];
    g.fillStyle = 'rgba(0,0,0,0.07)';
    for (var si = 0; si < legShadows.length; si++) {
      var s = legShadows[si];
      g.beginPath();
      g.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
      g.fill();
    }

    return addOutline(c, '#1a0e06');
  }

  // ---- Cat (32x32 canvas, body ~16px tall) ----
  function renderCat(frame) {
    const c = makeCanvas(32, 32), g = c.getContext('2d'), oy = 8;
    var B = '#1a1a1a', D = '#111', H = '#2a2a2a', fur = '#222';

    // ── Body (with fur volume) ──
    px(g, 8, oy+10, 16, 8, B);
    px(g, 7, oy+11, 18, 6, B);
    // Body highlight (light catching back)
    px(g, 9, oy+10, 14, 1, H);
    // Belly shadow (underside darker)
    px(g, 8, oy+16, 14, 2, D);

    // ── Head (rounder shape) ──
    px(g, 9, oy+4, 14, 8, B);
    px(g, 10, oy+3, 12, 2, B);
    px(g, 11, oy+2, 10, 1, B); // top of head rounder
    // Forehead highlight
    px(g, 12, oy+3, 8, 1, H);
    // Cheek fluff (wider face)
    px(g, 8, oy+7, 1, 3, fur);
    px(g, 23, oy+7, 1, 3, fur);

    // ── Ears (pointier with inner pink and fur tuft) ──
    // Left ear
    px(g, 9, oy+1, 4, 3, B); px(g, 10, oy, 2, 2, B);
    px(g, 10, oy+2, 2, 1, '#c66'); // inner pink (deeper)
    px(g, 11, oy+1, 1, 1, '#c66');
    // Right ear
    px(g, 19, oy+1, 4, 3, B); px(g, 20, oy, 2, 2, B);
    px(g, 20, oy+2, 2, 1, '#c66');
    px(g, 21, oy+1, 1, 1, '#c66');

    // ── Eyes (amber-green with slit pupils, more expressive) ──
    // Eye whites (dark surround)
    px(g, 11, oy+6, 5, 3, D);
    px(g, 16, oy+6, 5, 3, D);
    // Iris (amber-green glow)
    px(g, 12, oy+7, 3, 2, '#2d9b4e');
    px(g, 17, oy+7, 3, 2, '#2d9b4e');
    // Bright iris center
    px(g, 12, oy+7, 2, 1, '#3dbb5e');
    px(g, 17, oy+7, 2, 1, '#3dbb5e');
    // Slit pupils
    px(g, 13, oy+7, 1, 2, '#080808');
    px(g, 18, oy+7, 1, 2, '#080808');
    // Eye shine (tiny white dot)
    px(g, 12, oy+7, 1, 1, 'rgba(255,255,255,0.3)');
    px(g, 17, oy+7, 1, 1, 'rgba(255,255,255,0.3)');

    // ── Nose (small pink triangle) ──
    px(g, 15, oy+9, 2, 1, '#9a6060');
    px(g, 15, oy+10, 1, 1, fur); // mouth line

    // ── Whiskers (thinner, longer) ──
    g.strokeStyle = 'rgba(100,100,100,0.4)'; g.lineWidth = 0.4;
    // Left whiskers
    g.beginPath(); g.moveTo(11, oy+9); g.lineTo(5, oy+8); g.stroke();
    g.beginPath(); g.moveTo(11, oy+10); g.lineTo(4, oy+10); g.stroke();
    g.beginPath(); g.moveTo(11, oy+11); g.lineTo(5, oy+12); g.stroke();
    // Right whiskers
    g.beginPath(); g.moveTo(21, oy+9); g.lineTo(27, oy+8); g.stroke();
    g.beginPath(); g.moveTo(21, oy+10); g.lineTo(28, oy+10); g.stroke();
    g.beginPath(); g.moveTo(21, oy+11); g.lineTo(27, oy+12); g.stroke();

    // ── Tail (animated, with curve) ──
    if (frame === 0) {
      // Tail up and curled
      px(g, 24, oy+10, 3, 2, B);
      px(g, 26, oy+8, 2, 3, B);
      px(g, 27, oy+6, 2, 3, B);
      px(g, 26, oy+5, 2, 2, B); // curl tip
      px(g, 27, oy+6, 1, 1, H); // tip highlight
    } else {
      // Tail down and swaying
      px(g, 24, oy+12, 3, 2, B);
      px(g, 26, oy+14, 2, 3, B);
      px(g, 27, oy+16, 2, 3, B);
      px(g, 26, oy+18, 2, 1, B); // tip
      px(g, 27, oy+16, 1, 1, H); // tip highlight
    }

    // ── Collar (red with gold bell) ──
    // Collar band (sits on neck between head and body)
    px(g, 10, oy+11, 12, 1, '#a02020');
    // Collar highlight
    px(g, 11, oy+11, 10, 1, '#c03030');
    // Collar buckle (tiny gold square)
    px(g, 14, oy+11, 1, 1, '#b8960b');
    // Bell (dangling below collar center)
    g.fillStyle = '#d4a020';
    g.beginPath(); g.arc(16, oy + 12.5, 1.5, 0, Math.PI * 2); g.fill();
    // Bell highlight
    g.fillStyle = 'rgba(255,220,100,0.4)';
    g.beginPath(); g.arc(15.5, oy + 12, 0.5, 0, Math.PI * 2); g.fill();
    // Bell slit (dark line)
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(15.5, oy + 13, 1, 0.4);

    // ── Fur texture (subtle ticking on body — tabby hint) ──
    px(g, 12, oy+12, 1, 1, H);
    px(g, 15, oy+13, 1, 1, H);
    px(g, 18, oy+11, 1, 1, H);
    px(g, 10, oy+14, 1, 1, H);
    px(g, 20, oy+13, 1, 1, H);
    px(g, 14, oy+15, 1, 1, H);
    // Forehead M marking (classic tabby)
    px(g, 13, oy+4, 1, 1, fur);
    px(g, 14, oy+3, 1, 1, fur);
    px(g, 15, oy+4, 2, 1, fur);
    px(g, 17, oy+3, 1, 1, fur);
    px(g, 18, oy+4, 1, 1, fur);

    // ── Paws (with toe beans hint) ──
    px(g, 9, oy+17, 4, 2, H);  // left paw
    px(g, 19, oy+17, 4, 2, H); // right paw
    // Toe beans (tiny pink dots)
    px(g, 10, oy+18, 1, 1, '#6a4848');
    px(g, 11, oy+18, 1, 1, '#6a4848');
    px(g, 20, oy+18, 1, 1, '#6a4848');
    px(g, 21, oy+18, 1, 1, '#6a4848');
    // Claw hints (tiny dark dots at paw tips)
    px(g, 9, oy+18, 1, 1, 'rgba(20,20,20,0.3)');
    px(g, 12, oy+18, 1, 1, 'rgba(20,20,20,0.3)');
    px(g, 19, oy+18, 1, 1, 'rgba(20,20,20,0.3)');
    px(g, 22, oy+18, 1, 1, 'rgba(20,20,20,0.3)');

    return c;
  }

  function renderCatBlink() {
    const c = renderCat(0), g = c.getContext('2d'), oy = 8;
    // Clear open eyes (iris + pupil + shine area)
    g.clearRect(11, oy+6, 6, 4); g.clearRect(16, oy+6, 6, 4);
    // Redraw dark eye socket surround
    px(g, 11, oy+6, 5, 3, '#111');
    px(g, 16, oy+6, 5, 3, '#111');

    // ── Happy squint eyelids (curved lines, not flat) ──
    // Left eye — curved closed lid with slight smile shape
    g.strokeStyle = '#3dbb5e'; g.lineWidth = 0.8; // iris color peeks through
    g.beginPath();
    g.moveTo(12, oy + 8);
    g.quadraticCurveTo(13.5, oy + 7, 15, oy + 8);
    g.stroke();
    // Upper lid shadow (dark arc above)
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(12, oy + 7.5);
    g.quadraticCurveTo(13.5, oy + 6.5, 15, oy + 7.5);
    g.stroke();
    // Lower lid hint
    g.strokeStyle = 'rgba(50,50,50,0.3)'; g.lineWidth = 0.4;
    g.beginPath();
    g.moveTo(12, oy + 8.5);
    g.quadraticCurveTo(13.5, oy + 9, 15, oy + 8.5);
    g.stroke();

    // Right eye — mirrored
    g.strokeStyle = '#3dbb5e'; g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(17, oy + 8);
    g.quadraticCurveTo(18.5, oy + 7, 20, oy + 8);
    g.stroke();
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(17, oy + 7.5);
    g.quadraticCurveTo(18.5, oy + 6.5, 20, oy + 7.5);
    g.stroke();
    g.strokeStyle = 'rgba(50,50,50,0.3)'; g.lineWidth = 0.4;
    g.beginPath();
    g.moveTo(17, oy + 8.5);
    g.quadraticCurveTo(18.5, oy + 9, 20, oy + 8.5);
    g.stroke();

    // ── Cheek scrunch (happy blink pushes cheeks up slightly) ──
    px(g, 11, oy + 9, 2, 1, 'rgba(40,40,40,0.15)'); // left cheek puff
    px(g, 19, oy + 9, 2, 1, 'rgba(40,40,40,0.15)'); // right cheek puff

    return c;
  }

  // ---- Coffee machine (32x32) ----
  function renderMachine() {
    const c = makeCanvas(32, 32), g = c.getContext('2d');

    // ── Main body (brushed steel with gradient) ──
    var bodyGrd = g.createLinearGradient(6, 0, 26, 0);
    bodyGrd.addColorStop(0, '#3a4a5a');
    bodyGrd.addColorStop(0.3, '#4a5c6e');
    bodyGrd.addColorStop(0.5, '#556e80');
    bodyGrd.addColorStop(0.7, '#4a5c6e');
    bodyGrd.addColorStop(1, '#3a4a5a');
    g.fillStyle = bodyGrd;
    px(g, 6, 6, 20, 22, null); g.fillRect(6, 6, 20, 22);

    // Top cap (darker crown)
    g.fillStyle = '#2c3a48'; px(g, 5, 5, 22, 2, null); g.fillRect(5, 5, 22, 2);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(6, 5, 20, 1);

    // ── Front panel (recessed dark area) ──
    g.fillStyle = '#1a252f'; g.fillRect(8, 9, 16, 13);
    // Panel bevel
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(8, 9, 16, 1);
    g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(8, 21, 16, 1);

    // ── Pressure gauge (detailed) ──
    g.fillStyle = '#e8e0d0'; // cream face
    g.beginPath(); g.arc(16, 13, 3.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#556e80'; g.lineWidth = 0.8;
    g.beginPath(); g.arc(16, 13, 3.5, 0, Math.PI * 2); g.stroke();
    // Gauge markings
    g.fillStyle = '#333';
    for (var gi = 0; gi < 8; gi++) {
      var ga = (gi / 8) * Math.PI * 2 - Math.PI / 2;
      g.fillRect(16 + Math.cos(ga) * 2.5, 13 + Math.sin(ga) * 2.5, 1, 1);
    }
    // Red needle
    g.strokeStyle = '#c0392b'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(16, 13); g.lineTo(18, 11.5); g.stroke();
    // Center dot
    g.fillStyle = '#333';
    g.beginPath(); g.arc(16, 13, 0.8, 0, Math.PI * 2); g.fill();

    // ── Brushed steel texture (fine horizontal lines) ──
    g.strokeStyle = 'rgba(255,255,255,0.02)'; g.lineWidth = 0.3;
    for (var bsi = 7; bsi < 28; bsi += 2) {
      g.beginPath(); g.moveTo(7, bsi); g.lineTo(25, bsi); g.stroke();
    }

    // ── Side panel hex rivets (2 per side) ──
    var rivetColor = 'rgba(80,100,120,0.5)', rivetHi = 'rgba(160,180,200,0.25)';
    var rivets = [[7.5, 10], [7.5, 25], [24.5, 10], [24.5, 25]];
    for (var ri = 0; ri < rivets.length; ri++) {
      g.fillStyle = rivetColor;
      g.beginPath(); g.arc(rivets[ri][0], rivets[ri][1], 0.8, 0, Math.PI * 2); g.fill();
      g.fillStyle = rivetHi;
      g.beginPath(); g.arc(rivets[ri][0] - 0.2, rivets[ri][1] - 0.2, 0.3, 0, Math.PI * 2); g.fill();
    }

    // ── Brand logo plate (small brass rectangle below gauge) ──
    g.fillStyle = '#8b7340'; g.fillRect(13, 16.5, 6, 1.5);
    g.fillStyle = '#b8960b'; g.fillRect(13, 16.5, 6, 0.4); // brass highlight
    // Tiny engraved text simulation
    g.fillStyle = 'rgba(60,45,20,0.4)';
    g.fillRect(14, 17, 4, 0.5);

    // ── Control buttons (LED indicators with glow halos) ──
    // Power (green)
    g.fillStyle = '#1a3a1a'; px(g, 10, 18, 3, 2, null); g.fillRect(10, 18, 3, 2);
    // Green glow halo
    var greenGlow = g.createRadialGradient(11.5, 19, 0, 11.5, 19, 2.5);
    greenGlow.addColorStop(0, 'rgba(39,174,96,0.2)'); greenGlow.addColorStop(1, 'rgba(39,174,96,0)');
    g.fillStyle = greenGlow; g.fillRect(9, 17, 5, 4);
    g.fillStyle = '#27ae60'; g.beginPath(); g.arc(11.5, 19, 0.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5dde94'; g.beginPath(); g.arc(11.3, 18.8, 0.3, 0, Math.PI * 2); g.fill(); // specular
    // Brew (red)
    g.fillStyle = '#3a1a1a'; g.fillRect(14, 18, 3, 2);
    var redGlow = g.createRadialGradient(15.5, 19, 0, 15.5, 19, 2.5);
    redGlow.addColorStop(0, 'rgba(192,57,43,0.15)'); redGlow.addColorStop(1, 'rgba(192,57,43,0)');
    g.fillStyle = redGlow; g.fillRect(13, 17, 5, 4);
    g.fillStyle = '#c0392b'; g.beginPath(); g.arc(15.5, 19, 0.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e87468'; g.beginPath(); g.arc(15.3, 18.8, 0.3, 0, Math.PI * 2); g.fill();
    // Steam (amber)
    g.fillStyle = '#3a2a1a'; g.fillRect(18, 18, 3, 2);
    var amberGlow = g.createRadialGradient(19.5, 19, 0, 19.5, 19, 2.5);
    amberGlow.addColorStop(0, 'rgba(212,160,23,0.15)'); amberGlow.addColorStop(1, 'rgba(212,160,23,0)');
    g.fillStyle = amberGlow; g.fillRect(17, 17, 5, 4);
    g.fillStyle = '#d4a017'; g.beginPath(); g.arc(19.5, 19, 0.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f0c850'; g.beginPath(); g.arc(19.3, 18.8, 0.3, 0, Math.PI * 2); g.fill();

    // ── Nozzle / group head (chrome detail) ──
    g.fillStyle = '#8a9aaa'; g.fillRect(14, 21.5, 4, 2);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(14, 21.5, 4, 0.5);
    // Portafilter handle (wooden knob extending right)
    g.fillStyle = '#4a3020'; g.fillRect(18.5, 22, 4, 1.2);
    g.fillStyle = '#6d4c3d'; g.fillRect(18.5, 22, 4, 0.4); // wood highlight
    g.fillStyle = '#3a2218'; g.fillRect(22, 22, 1, 1.2); // knob end

    // ── Drip tray area ──
    g.fillStyle = '#3d566e'; g.fillRect(10, 22, 12, 1);
    g.fillStyle = '#0a0f14'; g.fillRect(11, 23, 10, 4);
    // Grate lines (cross-hatch)
    g.strokeStyle = 'rgba(60,80,100,0.3)'; g.lineWidth = 0.4;
    for (var di = 0; di < 5; di++) {
      g.beginPath(); g.moveTo(12 + di * 2, 23); g.lineTo(12 + di * 2, 27); g.stroke();
    }
    // Horizontal grate lines
    g.strokeStyle = 'rgba(60,80,100,0.15)'; g.lineWidth = 0.3;
    g.beginPath(); g.moveTo(11, 24.5); g.lineTo(21, 24.5); g.stroke();
    g.beginPath(); g.moveTo(11, 26); g.lineTo(21, 26); g.stroke();

    // ── Coffee drip stream (thin line from nozzle to cup) ──
    g.strokeStyle = 'rgba(80,45,15,0.3)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(16, 23.5); g.lineTo(16, 24.5); g.stroke();

    // ── Cup on drip tray ──
    // Cup shadow
    g.fillStyle = 'rgba(0,0,0,0.1)';
    g.beginPath(); g.ellipse(16, 26.5, 4, 0.8, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f0e8d0'; g.fillRect(13, 24, 6, 3);
    // Cup rim highlight
    g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(13, 24, 6, 0.5);
    g.fillStyle = '#3a2210'; g.fillRect(13.5, 24.5, 5, 1); // coffee surface
    // Coffee crema edge
    g.fillStyle = 'rgba(180,120,50,0.3)'; g.fillRect(13.5, 24.5, 5, 0.3);
    // Cup handle
    g.strokeStyle = '#e0d4b8'; g.lineWidth = 0.6;
    g.beginPath(); g.arc(20, 25.5, 1.5, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();

    // ── Base plate ──
    g.fillStyle = '#3d566e'; g.fillRect(6, 28, 20, 2);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(6, 28, 20, 1);
    // Base feet (rubber pads)
    g.fillStyle = '#1a1a1a';
    g.fillRect(8, 29.5, 2, 0.5); g.fillRect(22, 29.5, 2, 0.5);

    // ── Steam wisps (three, more organic curves) ──
    g.strokeStyle = 'rgba(200,220,240,0.12)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(14, 5); g.quadraticCurveTo(12, 2, 15, 0); g.stroke();
    g.beginPath(); g.moveTo(18, 5); g.quadraticCurveTo(20, 2, 17, 0); g.stroke();
    g.beginPath(); g.moveTo(16, 5); g.quadraticCurveTo(15, 3, 16.5, 1); g.stroke();
    // Steam fading at top
    g.strokeStyle = 'rgba(200,220,240,0.06)'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(15, 1); g.quadraticCurveTo(13, -1, 16, -2); g.stroke();

    return addOutline(c, '#0a0f14');
  }

  // ---- Pre-render all to cache ----
  function init() {
    ['up', 'down', 'left', 'right'].forEach(d => {
      [0, 1].forEach(f => { cache[`player_${d}_${f}`] = renderPlayer(d, f); });
    });
    Object.keys(NPC_COLORS).forEach(id => {
      ['up', 'down', 'left', 'right'].forEach(f => {
        cache[`npc_${id}_${f}`] = renderNpcSitting(id, f);
      });
    });
    cache.chair = renderChair();
    cache.cat_0 = renderCat(0); cache.cat_1 = renderCat(1);
    cache.cat_blink = renderCatBlink();
    cache.cruz_wipe_0 = renderCruzWipe(0); cache.cruz_wipe_1 = renderCruzWipe(1);
    cache.raindrop = renderRainDrop();
    cache.machine = renderMachine();
  }

  // ---- Public draw functions (same API as before) ----
  function drawPlayer(ctx, x, y, direction, frame) {
    const src = cache[`player_${direction}_${frame % 2}`];
    if (src) ctx.drawImage(src, x, y);
  }

  function drawNpc(ctx, x, y, npcId, facing, status) {
    // Cruz idle wipe cycle: 8-15s gap, then 2s wipe animation
    if (npcId === 'cruz') {
      var t = performance.now();
      var cycle = (t % 13000); // 13s cycle
      if (cycle > 11000) {
        // Wiping phase (2s)
        var wipeFrame = Math.floor((cycle - 11000) / 500) % 2;
        var wipeSrc = cache['cruz_wipe_' + wipeFrame];
        if (wipeSrc) ctx.drawImage(wipeSrc, x, y);
        if (status) drawStatusDot(ctx, x + 16, y - 4, status, t);
        return;
      }
    }
    const src = cache[`npc_${npcId}_${facing || 'down'}`];
    if (src) ctx.drawImage(src, x, y);
    if (status) drawStatusDot(ctx, x + 16, y - 4, status, performance.now());
  }

  function drawStatusDot(ctx, x, y, status, time) {
    var color = STATUS_COLORS[status] || STATUS_COLORS.good;
    // Breathing rhythm — full sine range so the amplitude is clearly visible
    var t = time / 1000;
    var breath = 0.5 + 0.5 * Math.sin(t * Math.PI * 0.8); // 0..1, no power crush

    // ── Outer ambient glow — strong enough to read on phone at arm's length ──
    var outerGlow = ctx.createRadialGradient(x, y, 0, x, y, 10);
    outerGlow.addColorStop(0, color);
    outerGlow.addColorStop(0.35, color);
    outerGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.20 + breath * 0.18; // 0.20–0.38, was 0–0.08
    ctx.fillStyle = outerGlow;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();

    // ── Middle halo (crisp pulse ring) ──
    var midGlow = ctx.createRadialGradient(x, y, 1.5, x, y, 6);
    midGlow.addColorStop(0, 'rgba(0,0,0,0)');
    midGlow.addColorStop(0.45, color);
    midGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.30 + breath * 0.25; // 0.30–0.55, was 0–0.15
    ctx.fillStyle = midGlow;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();

    // ── Core dot — 3px radius so it's always legible on phone ──
    var coreR = 2.5 + breath * 0.6; // 2.5–3.1px, breathes visibly
    var coreGrd = ctx.createRadialGradient(x - 0.6, y - 0.6, 0, x, y, coreR);
    coreGrd.addColorStop(0, '#ffffff');
    coreGrd.addColorStop(0.25, color);
    coreGrd.addColorStop(1, color);
    ctx.globalAlpha = 0.82 + breath * 0.18; // 0.82–1.0, always opaque
    ctx.fillStyle = coreGrd;
    ctx.beginPath(); ctx.arc(x, y, coreR, 0, Math.PI * 2); ctx.fill();

    // ── Specular highlight (crisp white spark at top-left) ──
    ctx.globalAlpha = 0.55 + breath * 0.30; // 0.55–0.85, was 0.3–0.7
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(x - 0.9, y - 0.9, 0.8, 0, Math.PI * 2); ctx.fill();

    ctx.globalAlpha = 1;
  }

  function drawPrompt(ctx, x, y, time) {
    // Smooth eased bounce — ease-in-out sine, ±3px arc (more visible on phone)
    var phase = (time % 900) / 900;
    var ease = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    var bob = Math.round((ease * 2 - 1) * 3); // integer snap: -3..+3
    var cy = y - 18 + bob; // centre of bubble — higher above NPC head

    // Bubble dimensions — wider & taller than before for phone readability
    var bw = 22, bh = 14, br = 4;
    // Snap bx to integer so all fills land on whole pixels (no sub-pixel blur)
    var bx = Math.round(x + 16 - bw / 2); // centred over tile
    var by = cy - Math.round(bh / 2);
    // Tail tip — centred below bubble
    var tx = Math.round(x + 16), tailY = by + bh + 4;

    // ── Attention ring (pulses in sync with bounce, fades as bubble rises) ──
    var ringPulse = 0.5 + 0.5 * Math.sin(time / 320);
    var ring = ctx.createRadialGradient(tx, tailY - 2, 2, tx, tailY - 2, 10);
    ring.addColorStop(0, 'rgba(231,76,60,0)');
    ring.addColorStop(0.55, 'rgba(231,76,60,' + (ringPulse * 0.18).toFixed(3) + ')');
    ring.addColorStop(1, 'rgba(231,76,60,0)');
    ctx.fillStyle = ring;
    ctx.beginPath(); ctx.arc(tx, tailY - 2, 10, 0, Math.PI * 2); ctx.fill();

    // ── Drop shadow (2px offset, integer coords) ──
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.moveTo(bx + br + 2, by + 2); ctx.lineTo(bx + bw - br + 2, by + 2);
    ctx.quadraticCurveTo(bx + bw + 2, by + 2, bx + bw + 2, by + br + 2);
    ctx.lineTo(bx + bw + 2, by + bh - br + 2);
    ctx.quadraticCurveTo(bx + bw + 2, by + bh + 2, bx + bw - br + 2, by + bh + 2);
    ctx.lineTo(bx + br + 2, by + bh + 2);
    ctx.quadraticCurveTo(bx + 2, by + bh + 2, bx + 2, by + bh - br + 2);
    ctx.lineTo(bx + 2, by + br + 2);
    ctx.quadraticCurveTo(bx + 2, by + 2, bx + br + 2, by + 2);
    ctx.fill();

    // ── Bubble body (warm white → cream gradient) ──
    var bubbleGrd = ctx.createLinearGradient(bx, by, bx, by + bh);
    bubbleGrd.addColorStop(0, '#ffffff');
    bubbleGrd.addColorStop(1, '#ede8df');
    ctx.fillStyle = bubbleGrd;
    ctx.beginPath();
    ctx.moveTo(bx + br, by); ctx.lineTo(bx + bw - br, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + br);
    ctx.lineTo(bx + bw, by + bh - br);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - br, by + bh);
    ctx.lineTo(bx + br, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - br);
    ctx.lineTo(bx, by + br);
    ctx.quadraticCurveTo(bx, by, bx + br, by);
    ctx.fill();

    // ── Bubble tail (solid triangle pointing down) ──
    ctx.fillStyle = '#ede8df';
    ctx.beginPath();
    ctx.moveTo(tx - 4, by + bh); ctx.lineTo(tx, tailY); ctx.lineTo(tx + 4, by + bh);
    ctx.fill();

    // ── Border (1px solid — crisp at all scales) ──
    ctx.strokeStyle = 'rgba(140,128,110,0.65)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + br, by); ctx.lineTo(bx + bw - br, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + br);
    ctx.lineTo(bx + bw, by + bh - br);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - br, by + bh);
    ctx.lineTo(tx + 4, by + bh); ctx.lineTo(tx, tailY); ctx.lineTo(tx - 4, by + bh);
    ctx.lineTo(bx + br, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - br);
    ctx.lineTo(bx, by + br);
    ctx.quadraticCurveTo(bx, by, bx + br, by);
    ctx.closePath(); ctx.stroke();

    // ── Inner top-edge highlight (1px white line — crisp) ──
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + br + 1, by + 1); ctx.lineTo(bx + bw - br - 1, by + 1);
    ctx.stroke();

    // ── Exclamation mark — pixel-perfect inside the bigger bubble ──
    var cx = Math.round(bx + bw / 2); // integer centre
    var midy = Math.round(by + bh / 2);

    // Soft radial glow behind "!" — more saturated & visible than before
    var exGlow = ctx.createRadialGradient(cx, midy, 0, cx, midy, 7);
    exGlow.addColorStop(0, 'rgba(231,76,60,0.22)');
    exGlow.addColorStop(1, 'rgba(231,76,60,0)');
    ctx.fillStyle = exGlow;
    ctx.fillRect(bx, by, bw, bh);

    // "!" bar — 3×6px solid rect (no roundRect to maximise compat)
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(cx - 1, midy - 5, 3, 5);

    // "!" dot — 3×3px solid square (pixel-art crisp, not sub-pixel circle)
    ctx.fillRect(cx - 1, midy + 2, 3, 3);

    // Specular on "!" bar top-left corner
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(cx - 1, midy - 5, 1, 2);
  }

  function drawChair(ctx, x, y) {
    const src = cache.chair; if (src) ctx.drawImage(src, x, y);
  }

  function drawCat(ctx, x, y, time) {
    const cycle = Math.floor(time / 3000) % 2;
    const blinking = window._catBlink && (time - window._catBlink < 300);
    const src = cache[blinking ? 'cat_blink' : `cat_${cycle}`];
    if (src) ctx.drawImage(src, x, y);
  }

  function drawSteam(ctx, x, y, time) {
    const src = cache.machine; if (src) ctx.drawImage(src, x, y);
    var t = time / 1000;
    // ── Main steam column (6 layered wisps with S-curve paths) ──
    for (var i = 0; i < 6; i++) {
      var period = 2.8 + i * 0.35;
      var phase = ((t + i * 0.45) % period) / period; // 0→1 lifecycle
      if (phase > 0.95) continue; // gap between cycles
      // S-curve path: two sine components for organic drift
      var drift = Math.sin(t * 1.2 + i * 1.7) * 3 + Math.sin(t * 0.7 + i * 2.3) * 1.5;
      var sx = x + 14 + drift * phase;
      var sy = y + 6 - phase * 16;
      // Size expands as steam rises and dissipates
      var size = 1 + phase * 2.5;
      // Opacity: fade in quickly, fade out slowly
      var alpha = phase < 0.15 ? phase / 0.15 : (1 - phase) / 0.85;
      alpha *= 0.4;
      // Warm tint near machine, cool white as it rises
      var warmth = 1 - phase;
      var r = Math.floor(255 - warmth * 15);
      var g = Math.floor(250 - warmth * 30);
      var b = Math.floor(245 - warmth * 45);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      // Draw as soft circle (arc) for rounder puffs
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    // ── Tiny hot droplets (fast, near spout — espresso pressure burst) ──
    for (var d = 0; d < 3; d++) {
      var dp = ((t * 2.5 + d * 1.1) % 1);
      if (dp > 0.6) continue;
      var ddx = x + 13.5 + Math.sin(t * 3 + d * 2.5) * 1.5;
      var ddy = y + 5 - dp * 6;
      ctx.globalAlpha = (1 - dp / 0.6) * 0.25;
      ctx.fillStyle = '#f0e8d8';
      ctx.fillRect(ddx, ddy, 0.8, 0.8);
    }
    ctx.globalAlpha = 1;
  }

  function drawRainOnWindows(ctx, time) {
    // Window positions from map: cols 3,5,7,9,11 at row 0
    var windowCols = [3, 5, 7, 9, 11];
    var drop = cache.raindrop;
    if (!drop) return;

    for (var w = 0; w < windowCols.length; w++) {
      var wx = windowCols[w] * 32;

      // ── Main drops (sliding down with wind drift) ──
      for (var d = 0; d < 3; d++) {
        var seed = w * 3 + d;
        var period = 4000 + seed * 700;
        var phase = (time + seed * 1234) % period;
        if (phase < 2800) {
          var progress = phase / 2800;
          // Wind drift: drops angle slightly left (wind from right)
          var windDrift = progress * 2.5;
          var dx = wx + 4 + ((seed * 7) % 24) - windDrift;
          var dy = progress * 28;
          // Acceleration: drops speed up as they fall
          dy = progress * progress * 28;
          var alpha = progress < 0.05 ? progress / 0.05 * 0.35 : 0.35 * (1 - progress * 0.4);
          ctx.globalAlpha = alpha;
          ctx.drawImage(drop, dx, dy);

          // ── Wet trail behind drop (elongated glass-smear streak) ──
          if (progress > 0.10) {
            var trailLen = Math.min(progress * 14, 10);
            var trailAlpha = alpha * 0.45;
            // Main wet smear — wider at top (where drop passed), tapers downward
            ctx.globalAlpha = trailAlpha;
            ctx.fillStyle = 'rgba(175,210,240,1)';
            ctx.fillRect(dx + 0.5, dy - trailLen, 1.2, trailLen);
            // Light-catch edge on the smear (interior lamp refraction)
            ctx.globalAlpha = trailAlpha * 0.5;
            ctx.fillStyle = 'rgba(255,255,255,1)';
            ctx.fillRect(dx + 0.3, dy - trailLen + 1, 0.3, trailLen - 2);
            // Fade-out tip (top of trail dries first)
            ctx.globalAlpha = trailAlpha * 0.15;
            ctx.fillStyle = 'rgba(175,210,240,1)';
            ctx.fillRect(dx + 0.5, dy - trailLen, 1.2, 2);
          }

          // ── Splash at bottom (when drop reaches sill) ──
          if (progress > 0.85) {
            var splashPhase = (progress - 0.85) / 0.15; // 0→1
            ctx.globalAlpha = (1 - splashPhase) * 0.25;
            ctx.fillStyle = 'rgba(200,225,250,0.5)';
            // 3 tiny splash droplets radiating outward
            var splashY = 28;
            var splashX = dx + 1.5;
            var spread = splashPhase * 3;
            ctx.fillRect(splashX - spread, splashY - splashPhase * 2, 0.8, 0.8);
            ctx.fillRect(splashX + spread, splashY - splashPhase * 1.5, 0.6, 0.6);
            ctx.fillRect(splashX, splashY - splashPhase * 3, 0.5, 0.5);
          }
          ctx.globalAlpha = 1;
        }
      }

      // ── Horizontal wind streaks (fast, thin, translucent) ──
      for (var s = 0; s < 2; s++) {
        var sSeed = w * 2 + s + 50;
        var sPeriod = 3000 + sSeed * 400;
        var sPhase = (time + sSeed * 987) % sPeriod;
        if (sPhase < 1200) {
          var sp = sPhase / 1200;
          var sy = 4 + ((sSeed * 11) % 20);
          var sxStart = wx + 2 + sp * 28;
          var streakLen = 4 + (1 - sp) * 3;
          ctx.globalAlpha = (1 - sp) * 0.12;
          ctx.strokeStyle = 'rgba(200,220,245,0.4)';
          ctx.lineWidth = 0.3;
          ctx.beginPath();
          ctx.moveTo(sxStart, sy);
          ctx.lineTo(sxStart + streakLen, sy + 0.5);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // ── Collected water bead (stationary, clings to glass before releasing) ──
      var beadSeed = w * 7 + 33;
      var beadCycle = (time + beadSeed * 555) % 6000;
      if (beadCycle < 4000) {
        var bx = wx + 8 + ((beadSeed * 3) % 16);
        var by = 6 + ((beadSeed * 5) % 12);
        // Bead grows then releases
        var bSize = beadCycle < 3000 ? (beadCycle / 3000) * 1.2 : 1.2;
        var bAlpha = beadCycle < 3000 ? 0.2 : 0.2 * (1 - (beadCycle - 3000) / 1000);
        ctx.globalAlpha = bAlpha;
        ctx.fillStyle = 'rgba(200,225,250,0.5)';
        ctx.beginPath(); ctx.arc(bx, by, bSize, 0, Math.PI * 2); ctx.fill();
        // Refraction highlight on bead
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath(); ctx.arc(bx - 0.3, by - 0.3, bSize * 0.3, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }

      // ── Animated condensation shimmer along bottom edge of window ──
      // Slow breathing pulse (4.5s cycle) — warm-meets-cold fog brightens and dims
      var shimmerCycle = (time * 0.00022 + w * 1.3);          // per-window phase offset
      var shimmerAlpha = 0.06 + Math.sin(shimmerCycle) * 0.04; // 0.02–0.10 range
      var shimmerY = 22;  // bottom strip of window (row 0, pixels 22-32)
      // Base fog band — cold blue-white over the condensation zone
      ctx.globalAlpha = shimmerAlpha;
      var shimGrd = ctx.createLinearGradient(wx, shimmerY, wx, shimmerY + 10);
      shimGrd.addColorStop(0,   'rgba(200,220,240,0)');
      shimGrd.addColorStop(0.5, 'rgba(200,222,242,1)');
      shimGrd.addColorStop(1,   'rgba(215,230,248,1)');
      ctx.fillStyle = shimGrd;
      ctx.fillRect(wx + 4, shimmerY, 24, 10);
      // Warm amber bleed — interior heat pulsing up through the fog
      var warmAlpha = 0.04 + Math.sin(shimmerCycle + 0.8) * 0.025;
      ctx.globalAlpha = warmAlpha;
      var warmGrd = ctx.createLinearGradient(wx, shimmerY + 5, wx, shimmerY + 10);
      warmGrd.addColorStop(0, 'rgba(255,170,60,0)');
      warmGrd.addColorStop(1, 'rgba(255,155,45,1)');
      ctx.fillStyle = warmGrd;
      ctx.fillRect(wx + 4, shimmerY + 5, 24, 5);
      // Condensation micro-beads scattered along fog line (tiny stationary drops)
      var microSeed = w * 13 + 77;
      for (var mi = 0; mi < 4; mi++) {
        var mx = wx + 5 + ((microSeed * (mi + 1) * 7) % 20);
        var my = shimmerY + 1 + ((microSeed * (mi + 1) * 3) % 5);
        var mSize = 0.5 + ((microSeed * mi) % 3) * 0.2;
        var mAlpha = 0.18 + shimmerAlpha * 0.8;
        ctx.globalAlpha = mAlpha;
        ctx.fillStyle = 'rgba(210,232,252,1)';
        ctx.beginPath(); ctx.arc(mx, my, mSize, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath(); ctx.arc(mx - mSize*0.3, my - mSize*0.3, mSize*0.3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---- Smoking cup (empty seat — Cruz is at the piano) ----
  // 6×4px brown cup with rising wispy steam lines, animated via sin wave.
  function drawSmokingCup(cctx, x, y, time) {
    // Center cup on the 32px tile — place it at the desk position
    var cx = x + 13, cy = y + 20;

    // ── Saucer (white ceramic, beneath cup) ──
    cctx.fillStyle = '#d8cbb4';
    cctx.beginPath(); cctx.ellipse(cx + 3, cy + 4, 5, 2, 0, 0, Math.PI * 2); cctx.fill();
    // Saucer inner ring
    cctx.strokeStyle = 'rgba(0,0,0,0.06)'; cctx.lineWidth = 0.3;
    cctx.beginPath(); cctx.ellipse(cx + 3, cy + 4, 3.5, 1.3, 0, 0, Math.PI * 2); cctx.stroke();
    // Saucer rim highlight
    cctx.strokeStyle = 'rgba(255,250,240,0.12)'; cctx.lineWidth = 0.4;
    cctx.beginPath(); cctx.ellipse(cx + 3, cy + 4, 5, 2, 0, Math.PI * 1.1, Math.PI * 1.6); cctx.stroke();

    // ── Cup shadow on saucer ──
    cctx.fillStyle = 'rgba(0,0,0,0.1)';
    cctx.beginPath(); cctx.ellipse(cx + 3.5, cy + 3.5, 3.5, 1.5, 0, 0, Math.PI * 2); cctx.fill();

    // ── Cup body (warm brown ceramic with gradient) ──
    var cupGrd = cctx.createLinearGradient(cx, cy, cx + 6, cy);
    cupGrd.addColorStop(0, '#6b4a35');
    cupGrd.addColorStop(0.4, '#7a5c48');
    cupGrd.addColorStop(0.7, '#6b4a35');
    cupGrd.addColorStop(1, '#5a3d2e');
    cctx.fillStyle = cupGrd;
    cctx.fillRect(cx, cy, 6, 4);
    // Cup bottom edge (rounded feel)
    cctx.fillStyle = '#5a3d2e';
    cctx.fillRect(cx + 0.5, cy + 3.5, 5, 0.5);

    // ── Cup interior shadow (depth into cup) ──
    cctx.fillStyle = 'rgba(0,0,0,0.15)';
    cctx.fillRect(cx + 0.5, cy + 0.5, 5, 1);

    // ── Coffee surface (dark liquid with warm reflection) ──
    cctx.fillStyle = '#2a1608';
    cctx.fillRect(cx + 0.5, cy + 0.3, 5, 1.2);
    // Surface reflection (window light on coffee)
    cctx.fillStyle = 'rgba(255,220,160,0.12)';
    cctx.fillRect(cx + 1, cy + 0.5, 1.5, 0.5);

    // ── White rim (ceramic lip catches light) ──
    cctx.fillStyle = '#f0ebe3';
    cctx.fillRect(cx, cy, 6, 0.8);
    // Rim inner edge shadow
    cctx.fillStyle = 'rgba(0,0,0,0.06)';
    cctx.fillRect(cx + 0.5, cy + 0.6, 5, 0.3);

    // ── Cup handle (curved arc, right side) ──
    cctx.strokeStyle = '#7a5c48'; cctx.lineWidth = 0.8;
    cctx.beginPath(); cctx.arc(cx + 7, cy + 2, 1.5, -Math.PI * 0.5, Math.PI * 0.5); cctx.stroke();
    // Handle highlight
    cctx.strokeStyle = 'rgba(160,120,80,0.2)'; cctx.lineWidth = 0.4;
    cctx.beginPath(); cctx.arc(cx + 7, cy + 1.5, 1.2, -Math.PI * 0.4, 0); cctx.stroke();

    // ── Cup specular highlight (ceramic gleam) ──
    cctx.fillStyle = 'rgba(255,240,220,0.15)';
    cctx.fillRect(cx + 1, cy + 1.5, 1, 2);

    // ── Steam: 3 wispy curving lines rising with sine wobble ──
    var t = time / 600;
    for (var i = 0; i < 3; i++) {
      var sx = cx + 1 + i * 2;
      for (var seg = 0; seg < 7; seg++) {
        var wobble = Math.sin(t * 1.5 + i * 2.1 + seg * 0.7) * (1.5 + seg * 0.2);
        var steamX = (sx + wobble) | 0;
        var steamY = cy - 2 - seg * 1.8;
        var alpha = (1 - seg / 7) * 0.35 * (0.5 + 0.5 * Math.sin(t + i * 0.9));
        cctx.globalAlpha = alpha;
        cctx.fillStyle = i === 1 ? '#f0f0f0' : '#ffffff';
        cctx.fillRect(steamX, steamY, 1, 1.5);
      }
    }
    cctx.globalAlpha = 1;
  }

  window.CafeSprites = { drawPlayer, drawNpc, drawStatusDot, drawPrompt, drawChair, drawCat, drawSteam, drawRainOnWindows, drawSmokingCup, init, getCache: function () { return cache; } };
})();
