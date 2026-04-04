/**
 * Cafe Ambience — Environmental Storytelling System
 * "Don't show numbers, show objects." — Eric Barone / Will Wright
 * Coffee cups, notebooks, time-aware states, mood weather, visitor ghosts, empty chair stories.
 */
(function () {
  'use strict';
  var T = 32;
  var npcData = null, mapData = null, mood = 'sunny';
  var ENERGY_CUPS = { '\u9AD8': 3, '\u4E2D': 2, '\u4F4E': 1 };
  var EMPTY_SEATS = ['empty1', 'empty2', 'empty3', 'lastSeat'];

  function hour() { return new Date().getHours(); }
  function isNight() { var h = hour(); return h >= 22 || h < 6; }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function seatPos(id) { return (mapData && mapData.seats) ? mapData.seats[id] || null : null; }
  function tablePixel(seat) { return { x: (seat.tileX - 1) * T, y: seat.tileY * T }; }

  // ── 1. Coffee Cups on Tables ─────────────────────────────────
  function drawCup(ctx, x, y, steam) {
    ctx.fillStyle = '#6d4c3d';
    ctx.fillRect(x, y + 1, 4, 4);
    ctx.fillRect(x + 4, y + 2, 1, 2); // handle
    ctx.fillStyle = '#8d6e63';
    ctx.fillRect(x, y, 4, 1); // rim
    if (steam) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillRect(x + 1, y - 2, 1, 1);
      ctx.fillRect(x + 2, y - 3, 1, 1);
    }
  }
  function drawCups(ctx, seat, count, warm) {
    var tp = tablePixel(seat), bx = tp.x + 4, by = tp.y + 6;
    for (var i = 0; i < count; i++) drawCup(ctx, bx + i * 7, by, warm);
  }

  // ── Digital Kintsugi: gold-cracked cup for long-absent visitors ──
  // "Cracks are not damage — they are the record of a journey." — Lucas Pope
  function drawKintsugiCup(ctx, x, y) {
    // Base cup (darker, weathered)
    ctx.fillStyle = '#4a3728';
    ctx.fillRect(x, y + 1, 4, 4);
    ctx.fillRect(x + 4, y + 2, 1, 2);
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(x, y, 4, 1);
    // Gold crack lines (kintsugi repair)
    ctx.fillStyle = '#ffd54f';
    ctx.fillRect(x + 1, y + 1, 1, 1);
    ctx.fillRect(x + 2, y + 2, 1, 1);
    ctx.fillRect(x + 3, y + 3, 1, 1);
    // Gold vein along handle
    ctx.fillStyle = '#ffb300';
    ctx.fillRect(x + 4, y + 3, 1, 1);
    // No steam — this cup has been waiting
  }
  function drawKintsugiOverlay(ctx, seat, absentDays, time) {
    if (absentDays < 21) return;
    var tp = tablePixel(seat);
    // Draw the kintsugi cup
    drawKintsugiCup(ctx, tp.x + 4, tp.y + 6);
    // Subtle gold glow pulse
    var pulse = 0.3 + 0.15 * Math.sin(time / 3000 * Math.PI);
    ctx.fillStyle = 'rgba(255,213,79,' + pulse.toFixed(2) + ')';
    ctx.fillRect(tp.x + 2, tp.y + 4, 8, 7);
    // "X days" marker
    if (absentDays > 30) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(tp.x + 16, tp.y + 2, 20, 9);
      ctx.fillStyle = '#ffd54f';
      ctx.font = '7px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(absentDays + 'd', tp.x + 18, tp.y + 9);
    }
  }

  // ── 2. Notebook Progress (days/90) ───────────────────────────
  function drawNotebook(ctx, seat, ratio) {
    var tp = tablePixel(seat), bx = tp.x + 4, by = tp.y + 18;
    var golden = ratio > 0.66;
    ctx.fillStyle = golden ? '#c9a800' : '#5d4037';
    ctx.fillRect(bx, by, 8, 6);
    ctx.fillStyle = '#3e2723';
    ctx.fillRect(bx + 3, by, 1, 6); // spine
    var fill = Math.min(Math.floor(ratio * 3), 3);
    ctx.fillStyle = '#d7ccc8';
    ctx.fillRect(bx + 1, by + 1, 2, 4);
    ctx.fillStyle = '#4e342e';
    for (var i = 0; i < fill; i++) ctx.fillRect(bx + 1, by + 1 + i, 2, 1);
    ctx.fillStyle = '#efebe9';
    ctx.fillRect(bx + 5, by + 1, 2, 4); // right page
  }

  // ── 3. Time-Aware NPC States ─────────────────────────────────
  function drawTimeState(ctx, seat) {
    var px = seat.tileX * T, py = seat.tileY * T, h = hour();
    if (h >= 6 && h < 12) {
      ctx.fillStyle = '#fdd835';
      ctx.fillRect(px + 12, py - 6, 3, 3);
      ctx.fillRect(px + 10, py - 4, 1, 1);
      ctx.fillRect(px + 16, py - 4, 1, 1);
    } else if (h >= 12 && h < 18) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(px + 8, py - 3, 5, 1);
      ctx.fillRect(px + 18, py - 3, 5, 1);
      ctx.fillRect(px + 13, py - 5, 5, 1);
    }
  }

  // ── 4. Cafe Ambience Indicator (weather icon top-right) ──────
  function computeMood() {
    if (!npcData) return 'sunny';
    var list = (typeof npcData.getNpcs === 'function') ? npcData.getNpcs() : [];
    var g = 0, y = 0, r = 0;
    for (var i = 0; i < list.length; i++) {
      var st = list[i].status;
      if (st === 'green') g++; else if (st === 'yellow') y++; else if (st === 'red') r++;
    }
    if (r > 0) return 'rainy';
    if (y > g) return 'cloudy';
    return 'sunny';
  }
  function drawWeather(ctx) {
    var bx = 15 * T - 22, by = 6;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(bx - 2, by - 2, 20, 20);
    if (mood === 'sunny') {
      ctx.fillStyle = '#fdd835';
      ctx.fillRect(bx + 5, by + 5, 6, 6);
      ctx.fillRect(bx + 7, by + 2, 2, 2);
      ctx.fillRect(bx + 7, by + 12, 2, 2);
      ctx.fillRect(bx + 2, by + 7, 2, 2);
      ctx.fillRect(bx + 12, by + 7, 2, 2);
    } else if (mood === 'cloudy') {
      ctx.fillStyle = '#b0bec5';
      ctx.fillRect(bx + 2, by + 6, 12, 5);
      ctx.fillRect(bx + 4, by + 4, 8, 3);
      ctx.fillStyle = '#fdd835';
      ctx.fillRect(bx + 11, by + 2, 4, 4);
    } else {
      ctx.fillStyle = '#78909c';
      ctx.fillRect(bx + 2, by + 4, 12, 5);
      ctx.fillRect(bx + 4, by + 2, 8, 3);
      ctx.fillStyle = '#42a5f5';
      ctx.fillRect(bx + 4, by + 11, 1, 2);
      ctx.fillRect(bx + 8, by + 11, 1, 2);
      ctx.fillRect(bx + 12, by + 11, 1, 2);
    }
  }

  // ── 5. Visitor Ghosts ────────────────────────────────────────
  function getCoffeeRecipients() {
    try {
      var raw = localStorage.getItem('cafe_coffees');
      if (!raw) return {};
      var arr = JSON.parse(raw), today = todayStr(), out = {};
      for (var i = 0; i < arr.length; i++)
        if (arr[i].date === today) out[arr[i].npcId] = true;
      return out;
    } catch (e) { return {}; }
  }
  function getVisitorCount() {
    try {
      var raw = localStorage.getItem('cafe_visitors');
      return raw ? (JSON.parse(raw).length || 0) : 0;
    } catch (e) { return 0; }
  }
  function drawSteamHeart(ctx, seat) {
    var px = (seat.tileX - 1) * T + 8, py = seat.tileY * T - 2;
    ctx.fillStyle = '#e57373';
    ctx.fillRect(px, py, 2, 1);
    ctx.fillRect(px + 3, py, 2, 1);
    ctx.fillRect(px, py + 1, 5, 1);
    ctx.fillRect(px + 1, py + 2, 3, 1);
    ctx.fillRect(px + 2, py + 3, 1, 1);
  }
  function drawVisitorCount(ctx) {
    var count = getVisitorCount();
    if (count <= 0) return;
    var W = 15 * T, H = 11 * T;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(W - 36, H - 16, 32, 12);
    ctx.fillStyle = '#b0bec5';
    ctx.font = '8px monospace'; ctx.textAlign = 'right';
    ctx.fillText('\uD83D\uDC41 ' + count, W - 6, H - 7);
  }

  // ── 6. The Empty Chair Story ─────────────────────────────────
  function drawEmptyChairStory(ctx, seat) {
    var tp = tablePixel(seat), cx = seat.tileX * T, cy = seat.tileY * T;
    // jacket draped on chair
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(cx + 8, cy + 4, 10, 6);
    ctx.fillStyle = '#4e342e';
    ctx.fillRect(cx + 10, cy + 2, 6, 3);
    // cold coffee (no steam)
    drawCup(ctx, tp.x + 10, tp.y + 8, false);
    // tiny note
    ctx.fillStyle = '#fff9c4';
    ctx.fillRect(tp.x + 18, tp.y + 10, 5, 4);
    ctx.fillStyle = '#999';
    ctx.fillRect(tp.x + 19, tp.y + 11, 3, 1);
    ctx.fillRect(tp.x + 19, tp.y + 13, 2, 1);
  }

  // ── Reserved seat star indicator ──────────────────────────────
  function drawReservedStar(ctx, seat, starName, time) {
    var cx = seat.tileX * T + 8, cy = seat.tileY * T - 6;
    var pulse = 0.7 + 0.3 * Math.sin(time / 1500 * Math.PI);
    ctx.fillStyle = 'rgba(245,166,35,' + pulse.toFixed(2) + ')';
    ctx.fillRect(cx + 1, cy, 3, 1);
    ctx.fillRect(cx, cy + 1, 5, 1);
    ctx.fillRect(cx + 1, cy + 2, 3, 1);
    ctx.fillRect(cx + 2, cy + 3, 1, 1);
    if (starName) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      var tw = ctx.measureText(starName).width;
      ctx.fillRect(cx - 2, cy + 5, tw + 4, 9);
      ctx.fillStyle = '#f5a623';
      ctx.font = '7px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(starName, cx, cy + 12);
    }
  }

  // ── Waiting list counter (above visitor count) ────────────────
  function drawWaitingCount(ctx) {
    var cafeState = (window.CafeInteractions) ? window.CafeInteractions.getState() : null;
    var wl = (cafeState && cafeState.waitingList) || [];
    if (wl.length <= 0) return;
    var W = 15 * T, H = 11 * T;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(W - 50, H - 30, 46, 12);
    ctx.fillStyle = '#f5a623';
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('\u2728 ' + wl.length + ' \u4F4D\u7B49\u5019', W - 6, H - 21);
  }

  // ── Note board on left wall (tile 1,4) ────────────────────────
  function drawNoteBoard(ctx, time) {
    var bx = 1 * T, by = 4 * T;
    // Cork board background
    ctx.fillStyle = '#8d6e63';
    ctx.fillRect(bx + 2, by + 4, T - 4, T - 8);
    ctx.fillStyle = '#a1887f';
    ctx.fillRect(bx + 3, by + 5, T - 6, T - 10);
    // Get note count
    var cafeState = (window.CafeInteractions) ? window.CafeInteractions.getState() : null;
    var noteCount = (cafeState && cafeState.notes) ? cafeState.notes.length : 0;
    if (noteCount > 0) {
      // Draw small paper notes
      var colors = ['#fff9c4', '#e1f5fe', '#f3e5f5', '#e8f5e9'];
      var shown = Math.min(noteCount, 4);
      for (var i = 0; i < shown; i++) {
        var nx = bx + 4 + (i % 2) * 12;
        var ny = by + 6 + Math.floor(i / 2) * 10;
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(nx, ny, 10, 7);
        ctx.fillStyle = '#999';
        ctx.fillRect(nx + 1, ny + 2, 7, 1);
        ctx.fillRect(nx + 1, ny + 4, 5, 1);
      }
      // Pin dots
      ctx.fillStyle = '#e53935';
      for (var p = 0; p < shown; p++) {
        var px2 = bx + 8 + (p % 2) * 12;
        var py2 = by + 6 + Math.floor(p / 2) * 10;
        ctx.fillRect(px2, py2, 2, 2);
      }
    }
  }

  // ── OPEN sign flicker ──────────────────────────────────────────
  function drawOpenFlicker(ctx, time) {
    // Random flicker: occasionally suppress brightness
    var flicker = Math.random() < 0.003 ? 0.3 : 1.0;
    // Slow pulse
    var pulse = 0.85 + 0.15 * Math.sin(time / 2000 * Math.PI);
    var alpha = 0.18 * flicker * pulse;
    // OPEN sign is at tile (10, 0) — overlay a glow
    var signX = 10 * T, signY = 0;
    ctx.fillStyle = 'rgba(255,160,0,' + alpha.toFixed(3) + ')';
    ctx.fillRect(signX + 2, 6, T - 4, T - 12);
  }

  // ── Night overlay ────────────────────────────────────────────
  function drawNightOverlay(ctx) {
    if (!isNight()) return;
    ctx.fillStyle = 'rgba(10,10,30,0.18)';
    ctx.fillRect(0, 0, 15 * T, 11 * T);
  }

  // ── 7. Visitor Streak Counter (bottom-left) ──────────────────
  function drawStreakCounter(ctx) {
    var streak = window._visitorStreak || 0;
    if (streak < 2) return;
    var H = 11 * T;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(4, H - 16, 36, 12);
    ctx.fillStyle = '#d4a017';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('\u2615\u00d7' + streak, 8, H - 7);
  }

  // ── Coffee count label from API state ───────────────────────
  function drawCoffeeLabel(ctx, seat, count) {
    var tp = tablePixel(seat);
    var x = tp.x + 18, y = tp.y + 2;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 1, y - 1, 14, 9);
    ctx.fillStyle = '#d4a017';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('\u2615\u00d7' + count, x, y + 6);
  }

  // ── Ghost Path Replay (Kojima-style translucent shadows) ─────
  function drawGhosts(ctx, time) {
    var cafeState = (window.CafeInteractions) ? window.CafeInteractions.getState() : null;
    var ghosts = (cafeState && cafeState.ghosts) ? cafeState.ghosts : [];
    if (ghosts.length === 0) return;
    var shown = ghosts.slice(-3);
    for (var g = 0; g < shown.length; g++) {
      var path = shown[g].path;
      if (!path || path.length < 2) continue;
      var totalFrames = 0;
      for (var i = 0; i < path.length; i++) totalFrames += (path[i].frames || 30);
      var durationMs = Math.max(totalFrames * 16.67, 2500);
      var offset = g * 2300;
      var t = ((time + offset) % durationMs) / durationMs;
      var targetFrame = t * totalFrames;
      var accum = 0, segIdx = 0;
      for (var i = 0; i < path.length; i++) {
        if (accum + (path[i].frames || 30) >= targetFrame) { segIdx = i; break; }
        accum += (path[i].frames || 30);
      }
      var segProgress = Math.max(0, Math.min(1, (targetFrame - accum) / (path[segIdx].frames || 30)));
      var cx = path[segIdx].x, cy = path[segIdx].y;
      if (segIdx < path.length - 1 && segProgress > 0) {
        var nx = path[segIdx + 1].x, ny = path[segIdx + 1].y;
        var s = segProgress * segProgress * (3 - 2 * segProgress);
        cx = cx + (nx - cx) * s; cy = cy + (ny - cy) * s;
      }
      var alpha = 1;
      if (t < 0.08) alpha = t / 0.08;
      else if (t > 0.85) alpha = (1 - t) / 0.15;
      alpha *= 0.14;
      var dir = 'down';
      if (segIdx < path.length - 1) {
        var dx = path[segIdx + 1].x - path[segIdx].x;
        var dy = path[segIdx + 1].y - path[segIdx].y;
        if (Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
        else if (dy !== 0) dir = dy > 0 ? 'down' : 'up';
      }
      var px = cx * T, py = cy * T;
      var oldAlpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha;
      if (window.CafeSprites && window.CafeSprites.drawPlayer) {
        window.CafeSprites.drawPlayer(ctx, px, py, dir, Math.floor(time / 300) % 2);
      } else {
        ctx.fillStyle = 'rgba(200,200,230,1)';
        ctx.beginPath(); ctx.arc(px + T / 2, py + 8, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(px + 10, py + 12, 12, 12);
      }
      ctx.globalAlpha = oldAlpha;
    }
  }

  // ── 8. Dust Motes (懸浮微塵) ────────────────────────────────
  // 5-10 particles drifting in window light beams.
  // Pure Math.sin() physics, zero allocations per frame.
  var dustCount = 8;
  var dust = null;
  // Window beam zones (tile coords): top row has windows at col 3,5,7,9,11
  var BEAM_ZONES = [
    { x1: 3 * T + 8, x2: 4 * T, y1: 1 * T, y2: 6 * T },
    { x1: 5 * T + 8, x2: 6 * T, y1: 1 * T, y2: 6 * T },
    { x1: 7 * T + 8, x2: 8 * T, y1: 1 * T, y2: 6 * T },
    { x1: 9 * T + 8, x2: 10 * T, y1: 1 * T, y2: 6 * T },
    { x1: 11 * T + 8, x2: 12 * T, y1: 1 * T, y2: 6 * T }
  ];
  function initDust() {
    dust = [];
    for (var i = 0; i < dustCount; i++) {
      var zone = BEAM_ZONES[i % BEAM_ZONES.length];
      dust.push({
        // Start position within beam zone
        x: zone.x1 + Math.random() * (zone.x2 - zone.x1),
        y: zone.y1 + Math.random() * (zone.y2 - zone.y1),
        // Each mote has unique phase offsets for organic feel
        phaseY: Math.random() * Math.PI * 2,
        phaseX: Math.random() * Math.PI * 2,
        speedY: 0.0003 + Math.random() * 0.0004,   // slow upward drift
        speedX: 0.0005 + Math.random() * 0.0003,   // gentle horizontal sway
        baseAlpha: 0.15 + Math.random() * 0.2,     // semi-transparent
        zone: i % BEAM_ZONES.length,
        size: Math.random() < 0.3 ? 2 : 1          // occasional larger mote
      });
    }
  }
  function drawDust(ctx, time) {
    if (!dust) initDust();
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      var zone = BEAM_ZONES[d.zone];
      // Float upward, wrap around
      var cy = d.y - (time * d.speedY);
      var range = zone.y2 - zone.y1;
      cy = zone.y1 + ((cy - zone.y1) % range + range) % range;
      // Horizontal sway
      var cx = d.x + Math.sin(time * d.speedX + d.phaseX) * 6;
      // Alpha: fade at edges of beam zone
      var edgeFade = 1.0;
      var topDist = cy - zone.y1, botDist = zone.y2 - cy;
      if (topDist < 20) edgeFade = topDist / 20;
      if (botDist < 20) edgeFade = Math.min(edgeFade, botDist / 20);
      var alpha = d.baseAlpha * edgeFade;
      // Only visible in daytime / early evening
      if (isNight()) alpha *= 0.3;
      ctx.fillStyle = 'rgba(255,240,210,' + alpha.toFixed(3) + ')';
      ctx.fillRect(Math.round(cx), Math.round(cy), d.size, d.size);
    }
  }

  // ── 9. Light Breathing (光影呼吸) ───────────────────────────
  // Edison bulb glow over counter (tile 5-9, row 1) + wall clock
  function drawLightBreathing(ctx, time) {
    var breath = Math.sin(time / 2000);
    // Counter Edison bulb area — warm amber glow
    var alpha = 0.06 + 0.02 * breath;
    ctx.fillStyle = 'rgba(245,180,80,' + alpha.toFixed(3) + ')';
    // Glow over counter tiles (row 1, cols 5-9)
    ctx.fillRect(5 * T, 0, 5 * T, 3 * T);
    // Smaller concentrated glow directly above Cruz
    var cruzAlpha = 0.04 + 0.015 * breath;
    ctx.fillStyle = 'rgba(255,200,100,' + cruzAlpha.toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(7 * T + 16, 1 * T + 16, 40, 0, Math.PI * 2);
    ctx.fill();
    // Wall clock faint halo (tile 13, row 1)
    var clockAlpha = 0.03 + 0.01 * breath;
    ctx.fillStyle = 'rgba(255,220,160,' + clockAlpha.toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(13 * T + 16, 1 * T + 16, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Main draw (called every frame from engine) ───────────────
  function drawAll(ctx, time) {
    if (!mapData) return;
    var list = (typeof npcData.getNpcs === 'function') ? npcData.getNpcs() : [];
    var coffeeMap = getCoffeeRecipients();
    var npcIds = {};
    for (var i = 0; i < list.length; i++) npcIds[list[i].id] = list[i];

    // Ghosts — draw before real entities so they appear behind
    drawGhosts(ctx, time);

    // Get API cafe state for coffee counts
    var cafeState = (window.CafeInteractions) ? window.CafeInteractions.getState() : null;
    var apiCoffees = (cafeState && cafeState.coffees) || {};

    for (var k = 0; k < list.length; k++) {
      var npc = list[k];
      var seat = seatPos(npc.id);
      if (!seat) continue;
      var cups = (typeof npcData.getCoffeeCups === 'function') ? npcData.getCoffeeCups(npc.id) : 1;
      var nb = (typeof npcData.getNotebookPage === 'function') ? npcData.getNotebookPage(npc.id) : { ratio: 0 };
      if (npc.id !== 'cruz') {
        drawCups(ctx, seat, cups, !isNight());
        drawNotebook(ctx, seat, nb.ratio || 0);
        drawTimeState(ctx, seat);
      }
      if (coffeeMap[npc.id]) drawSteamHeart(ctx, seat);
      // Show ☕×N from API state
      var sent = apiCoffees[npc.id];
      if (sent && sent > 0) drawCoffeeLabel(ctx, seat, sent);
    }
    // empty seats — show chair story or reserved star
    var cafeState2 = (window.CafeInteractions) ? window.CafeInteractions.getState() : null;
    var wl = (cafeState2 && cafeState2.waitingList) || [];
    // Build seat→starName map from waiting list
    var seatStars = {};
    for (var w = 0; w < wl.length; w++) {
      if (wl[w].seat && wl[w].star) seatStars[wl[w].seat] = wl[w].star;
    }
    for (var e = 0; e < EMPTY_SEATS.length; e++) {
      var es = seatPos(EMPTY_SEATS[e]);
      if (!es || npcIds[EMPTY_SEATS[e]]) continue;
      if (seatStars[EMPTY_SEATS[e]]) {
        drawReservedStar(ctx, es, seatStars[EMPTY_SEATS[e]], time);
      } else {
        drawEmptyChairStory(ctx, es);
      }
    }
    drawLightBreathing(ctx, time);
    drawDust(ctx, time);
    drawDynamicGallery(ctx, time);
    drawNightOverlay(ctx);
    drawLightBreathing(ctx, time);
    drawDust(ctx, time);
    // Window rain drops (from sprites cache)
    if (window.CafeSprites && window.CafeSprites.drawRainOnWindows) {
      window.CafeSprites.drawRainOnWindows(ctx, time);
    }
    drawOpenFlicker(ctx, time);
    drawNoteBoard(ctx, time);
    drawWeather(ctx);
    drawVisitorCount(ctx);
    drawStreakCounter(ctx);
    drawWaitingCount(ctx);

    // ── Digital Kintsugi: absent visitor's gold-cracked cup ──
    // "The cracks are the story." — Lucas Pope
    var absentDays = window._cafeAbsentDays || 0;
    if (absentDays >= 21) {
      // Find Cruz's seat for the kintsugi overlay
      var cruzSeat = seatPos('cruz');
      if (cruzSeat) drawKintsugiOverlay(ctx, cruzSeat, absentDays, time);
    }
  }

  // ── 10. DynamicGallery v2 — Sprint Art: Public Domain Assimilation ──
  // "Art is not what you see, but what you make others see." — Degas
  // 2-tile wide painting (7-8, row 0), metallic frame, color extraction → GI
  // Safe list: Van Gogh (†1890), Monet (†1926), Da Vinci (†1519), Klimt (†1918), Seurat (†1891)
  var gallery = {
    current: null,        // current painting key
    next: null,           // painting we're fading to
    fadeStart: 0,         // time when crossfade began
    fadeDuration: 5000,   // 5 seconds
    canvases: {},         // painting key → offscreen canvas
    lastArchetype: null,
    // 2-tile wide frame: tiles (7,0)-(8,0) = 64×32, painting area 56×24
    frameX: 7 * T,
    frameY: 0,
    frameW: T * 2,        // 64px
    frameH: T,            // 32px
    artX: 7 * T + 4,
    artY: 0 + 4,
    artW: 56,
    artH: 24,
    // Color extraction for global illumination
    dominantColor: { r: 40, g: 30, b: 20 },  // current painting's dominant color
    targetColor: null,                         // color we're fading to
    giAlpha: 0.0                               // global illumination intensity
  };

  // ── Archetype → Painting mapping with dominant colors for GI ──
  var PAINTING_DATA = {
    starry_night:        { color: { r: 20, g: 40, b: 100 }, name: 'Starry Night' },
    water_lilies:        { color: { r: 40, g: 90, b: 100 }, name: 'Water Lilies' },
    vitruvian:           { color: { r: 160, g: 140, b: 100 }, name: 'Vitruvian Man' },
    the_kiss:            { color: { r: 180, g: 150, b: 30 }, name: 'The Kiss' },
    impression_sunrise:  { color: { r: 60, g: 80, b: 120 }, name: 'Impression, Sunrise' },
    last_supper:         { color: { r: 140, g: 120, b: 90 }, name: 'Last Supper' },
    tree_of_life:        { color: { r: 170, g: 140, b: 20 }, name: 'Tree of Life' },
    grande_jatte:        { color: { r: 80, g: 110, b: 60 }, name: 'Sunday on La Grande Jatte' }
  };
  var ARCHETYPE_PAINTINGS = {
    'creative_anxiety':  'starry_night',     // Van Gogh — turbulence as beauty
    'seeker':            'water_lilies',     // Monet — reflection, depth beneath calm
    'builder':           'vitruvian',        // Da Vinci — structure, proportion, ambition
    'dreamer':           'the_kiss',         // Klimt — gold leaf transcendence
    'wounded':           'starry_night',     // Van Gogh — pain transformed to wonder
    'restless':          'impression_sunrise', // Monet — dawn after dark night
    'mentor':            'last_supper',      // Da Vinci — gathering, teaching, legacy
    'hermit':            'water_lilies',     // Monet — solitude as garden
    'rebel':             'tree_of_life',     // Klimt — defiance of convention
    'overwhelmed':       'grande_jatte',     // Seurat — step back, see the whole picture
    'default':           'starry_night'      // Default
  };

  // ── HD Pixel art painting renderers (56×24 wide format) ──
  function renderPainting(key) {
    var W = 56, H = 24;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    var painters = {
      starry_night: function () {
        // Van Gogh — swirling night sky, village silhouette, cypress
        g.fillStyle = '#0a1a3a'; g.fillRect(0, 0, W, H);
        // Deep sky layers
        g.fillStyle = '#0e2450'; g.fillRect(0, 0, W, 14);
        g.fillStyle = '#1a3a6a'; g.fillRect(4, 2, 48, 8);
        // Swirl bands (signature turbulence)
        g.fillStyle = '#2a5a9a';
        g.fillRect(6, 3, 12, 2); g.fillRect(22, 2, 14, 3); g.fillRect(40, 3, 10, 2);
        g.fillStyle = '#3a7aba';
        g.fillRect(8, 5, 10, 2); g.fillRect(26, 5, 10, 2); g.fillRect(42, 5, 8, 2);
        g.fillStyle = 'rgba(100,180,255,0.45)';
        g.fillRect(10, 4, 8, 1); g.fillRect(28, 3, 8, 1); g.fillRect(44, 4, 6, 1);
        g.fillRect(12, 7, 6, 1); g.fillRect(30, 6, 6, 1);
        // Stars — bright spiraling yellow
        g.fillStyle = '#ffd54f';
        g.fillRect(8, 2, 3, 3); g.fillRect(20, 1, 3, 3); g.fillRect(34, 2, 3, 3);
        g.fillRect(46, 3, 2, 2); g.fillRect(14, 5, 2, 2);
        // Star halos
        g.fillStyle = 'rgba(255,213,79,0.3)';
        g.fillRect(7, 1, 5, 5); g.fillRect(19, 0, 5, 5); g.fillRect(33, 1, 5, 5);
        // Moon (crescent, right)
        g.fillStyle = '#ffe082'; g.fillRect(48, 1, 4, 4);
        g.fillStyle = '#ffd54f'; g.fillRect(49, 2, 2, 2);
        g.fillStyle = '#0e2450'; g.fillRect(50, 1, 2, 3);
        // Cypress tree (dark flame shape, left)
        g.fillStyle = '#0a2a1a';
        g.fillRect(2, 6, 4, 18); g.fillRect(3, 3, 2, 4);
        g.fillStyle = '#0e3520'; g.fillRect(3, 8, 2, 10);
        // Rolling hills
        g.fillStyle = '#1a3a2a'; g.fillRect(6, 14, 48, 3);
        g.fillStyle = '#1a2a20'; g.fillRect(10, 15, 40, 2);
        // Village silhouette
        g.fillStyle = '#1a1a2a'; g.fillRect(8, 16, 42, 8);
        // Church spire (center focal point)
        g.fillRect(26, 12, 3, 5);
        g.fillRect(27, 10, 1, 3);
        // Houses with rooflines
        g.fillStyle = '#1e1e30';
        g.fillRect(10, 15, 6, 3); g.fillRect(20, 14, 5, 4); g.fillRect(36, 15, 8, 3);
        // Warm lit windows
        g.fillStyle = '#ffa726';
        g.fillRect(11, 18, 1, 1); g.fillRect(14, 17, 1, 1); g.fillRect(22, 18, 1, 1);
        g.fillRect(30, 19, 1, 1); g.fillRect(38, 18, 1, 1); g.fillRect(42, 17, 1, 1);
        g.fillRect(46, 19, 1, 1);
      },
      water_lilies: function () {
        // Monet — wide pond, lily pads scattered, soft impressionist blurs
        g.fillStyle = '#1a4a5a'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#2a6a7a'; g.fillRect(0, 0, W, 10);
        g.fillStyle = '#1a5060'; g.fillRect(0, 10, W, 8);
        g.fillStyle = '#0e3a4a'; g.fillRect(0, 18, W, 6);
        // Water ripples
        g.fillStyle = 'rgba(160,220,240,0.25)';
        var ripples = [[3,3,8],[16,6,10],[32,4,12],[44,8,8],[8,14,10],[26,16,14],[42,18,8]];
        for (var ri = 0; ri < ripples.length; ri++) g.fillRect(ripples[ri][0], ripples[ri][1], ripples[ri][2], 1);
        // Lily pads (organic ovals)
        g.fillStyle = '#2a6a3a';
        var pads = [[4,5,5,3],[16,8,6,3],[30,6,5,3],[44,10,5,3],[10,14,6,4],[24,16,5,3],[38,18,6,3],[50,14,4,3]];
        for (var pi = 0; pi < pads.length; pi++) g.fillRect(pads[pi][0], pads[pi][1], pads[pi][2], pads[pi][3]);
        // Pad highlights
        g.fillStyle = '#3a8a4a';
        for (var pi = 0; pi < pads.length; pi++) g.fillRect(pads[pi][0]+1, pads[pi][1], pads[pi][2]-2, 1);
        // Flowers (pink/white blooms)
        g.fillStyle = '#f8bbd0';
        g.fillRect(5, 5, 3, 2); g.fillRect(17, 8, 3, 2); g.fillRect(31, 6, 2, 2); g.fillRect(45, 10, 2, 2);
        g.fillStyle = '#fff';
        g.fillRect(6, 5, 1, 1); g.fillRect(18, 8, 1, 1); g.fillRect(46, 10, 1, 1);
        g.fillRect(11, 14, 2, 2); g.fillRect(25, 16, 2, 2);
        // Willow reflections (vertical streaks)
        g.fillStyle = 'rgba(60,120,80,0.2)';
        g.fillRect(0, 0, 2, H); g.fillRect(W-3, 0, 3, H);
        g.fillRect(20, 0, 1, 12); g.fillRect(36, 0, 1, 10);
      },
      vitruvian: function () {
        // Da Vinci — wide parchment, proportional figure, geometry
        g.fillStyle = '#d4c4a0'; g.fillRect(0, 0, W, H);
        // Parchment aging
        g.fillStyle = 'rgba(140,120,80,0.15)'; g.fillRect(0, 0, W, 2); g.fillRect(0, H-2, W, 2);
        g.fillStyle = 'rgba(160,140,100,0.1)'; g.fillRect(0, 0, 2, H); g.fillRect(W-2, 0, 2, H);
        // Text lines (da Vinci mirror writing)
        g.fillStyle = 'rgba(80,60,30,0.2)';
        for (var ti = 0; ti < 5; ti++) { g.fillRect(2, 2 + ti * 4, 14, 1); g.fillRect(W-16, 2 + ti * 4, 14, 1); }
        // Square (centered)
        g.strokeStyle = 'rgba(80,60,30,0.5)'; g.lineWidth = 1;
        g.strokeRect(W/2-10, 2, 20, 20);
        // Circle
        g.beginPath(); g.arc(W/2, 12, 11, 0, Math.PI * 2); g.stroke();
        // Figure
        g.fillStyle = '#5a4020';
        g.fillRect(W/2-1, 4, 2, 2);  // head
        g.fillRect(W/2-1, 6, 2, 7);  // torso
        g.fillRect(W/2-8, 8, 7, 1); g.fillRect(W/2+1, 8, 7, 1); // arms spread
        g.fillRect(W/2-6, 5, 5, 1); g.fillRect(W/2+1, 5, 5, 1); // arms up
        g.fillRect(W/2-2, 13, 1, 7); g.fillRect(W/2+1, 13, 1, 7); // legs
        g.fillRect(W/2-5, 14, 1, 6); g.fillRect(W/2+4, 14, 1, 6); // legs spread
      },
      the_kiss: function () {
        // Klimt — wide gold composition, two figures, mosaic
        g.fillStyle = '#c9a800'; g.fillRect(0, 0, W, H);
        // Dark earth below
        g.fillStyle = '#2a1a0a'; g.fillRect(0, 16, W, 8);
        g.fillStyle = '#1a2a1a'; g.fillRect(0, 20, W, 4);
        // Flower meadow
        g.fillStyle = '#4a8a3a';
        for (var fi = 0; fi < 12; fi++) g.fillRect(2 + fi * 5, 18 + (fi % 3), 3, 2);
        // Figures (golden merged form, center)
        g.fillStyle = '#d4a800'; g.fillRect(18, 2, 20, 16);
        g.fillStyle = '#8a6800'; g.fillRect(18, 2, 1, 16); g.fillRect(37, 2, 1, 16);
        // Mosaic rectangles on robes
        g.fillStyle = '#e8c800';
        var mosaic = [[20,4],[24,4],[28,4],[32,4],[22,8],[26,8],[30,8],[34,8],[21,12],[25,12],[29,12],[33,12]];
        for (var mi = 0; mi < mosaic.length; mi++) g.fillRect(mosaic[mi][0], mosaic[mi][1], 3, 3);
        // Klimt spirals (gold dots)
        g.fillStyle = '#ffd54f';
        g.fillRect(21, 5, 1, 1); g.fillRect(25, 5, 1, 1); g.fillRect(29, 5, 1, 1); g.fillRect(33, 5, 1, 1);
        g.fillRect(23, 9, 1, 1); g.fillRect(27, 9, 1, 1); g.fillRect(31, 9, 1, 1); g.fillRect(35, 9, 1, 1);
        // Faces
        g.fillStyle = '#e8c090';
        g.fillRect(24, 2, 3, 3); g.fillRect(28, 3, 3, 3);
        // Hair
        g.fillStyle = '#3a2a0a'; g.fillRect(24, 1, 4, 1);
        g.fillStyle = '#8a4a0a'; g.fillRect(29, 2, 3, 1);
        // Side decorative panels
        g.fillStyle = '#b09000';
        g.fillRect(2, 2, 12, 14); g.fillRect(42, 2, 12, 14);
        g.fillStyle = 'rgba(200,170,40,0.4)';
        g.fillRect(4, 4, 3, 3); g.fillRect(8, 4, 3, 3); g.fillRect(44, 4, 3, 3); g.fillRect(48, 4, 3, 3);
      },
      impression_sunrise: function () {
        // Monet — wide harbor, orange sun, boat silhouettes, mist
        g.fillStyle = '#2a4a6a'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#3a5a7a'; g.fillRect(0, 4, W, 6);
        g.fillStyle = '#4a6a8a'; g.fillRect(0, 8, W, 4);
        // Sunrise glow
        g.fillStyle = 'rgba(255,140,60,0.35)'; g.fillRect(16, 2, 24, 10);
        g.fillStyle = 'rgba(255,100,40,0.2)'; g.fillRect(12, 4, 32, 6);
        // Sun
        g.fillStyle = '#ff6a00'; g.fillRect(24, 3, 6, 4);
        g.fillStyle = '#ff8a20'; g.fillRect(25, 2, 4, 1); g.fillRect(25, 7, 4, 1);
        // Haze on horizon
        g.fillStyle = 'rgba(120,140,160,0.3)'; g.fillRect(0, 10, W, 4);
        // Water
        g.fillStyle = '#1a3a5a'; g.fillRect(0, 13, W, 11);
        // Sun reflection (broken orange streaks)
        g.fillStyle = '#ff6a00';
        g.fillRect(25, 14, 4, 1); g.fillRect(23, 16, 8, 1);
        g.fillRect(21, 18, 12, 1); g.fillRect(24, 20, 6, 1);
        g.fillStyle = 'rgba(255,106,0,0.5)';
        g.fillRect(20, 15, 2, 1); g.fillRect(32, 17, 3, 1);
        // Boats
        g.fillStyle = '#0a1a2a';
        g.fillRect(4, 14, 8, 3); g.fillRect(6, 13, 4, 1); // boat 1
        g.fillRect(40, 15, 6, 2); g.fillRect(42, 14, 3, 1); // boat 2
        g.fillRect(18, 16, 5, 2); g.fillRect(19, 15, 3, 1); // boat 3
        // Masts
        g.fillRect(8, 8, 1, 6); g.fillRect(43, 10, 1, 5); g.fillRect(20, 11, 1, 5);
        // Industrial silhouette on horizon (smokestacks)
        g.fillStyle = 'rgba(20,30,40,0.4)';
        g.fillRect(0, 10, 10, 4); g.fillRect(46, 10, 10, 4);
        g.fillRect(3, 7, 2, 4); g.fillRect(48, 8, 2, 3);
      },
      last_supper: function () {
        // Da Vinci — wide table, 13 figures, 3-point perspective
        g.fillStyle = '#b0a080'; g.fillRect(0, 0, W, H);
        // Ceiling coffers (perspective lines converging to center)
        g.fillStyle = '#a09070'; g.fillRect(0, 0, W, 6);
        g.fillStyle = 'rgba(80,60,40,0.15)';
        g.fillRect(0, 1, W, 1); g.fillRect(0, 3, W, 1); g.fillRect(0, 5, W, 1);
        // Three arched windows
        g.fillStyle = '#8ab0d0';
        g.fillRect(8, 1, 8, 7); g.fillRect(24, 1, 8, 7); g.fillRect(40, 1, 8, 7);
        // Arch tops
        g.fillStyle = '#a09070';
        g.fillRect(8, 1, 2, 1); g.fillRect(14, 1, 2, 1);
        g.fillRect(24, 1, 2, 1); g.fillRect(30, 1, 2, 1);
        g.fillRect(40, 1, 2, 1); g.fillRect(46, 1, 2, 1);
        // Central figure (Christ — slightly larger, blue/red robe)
        g.fillStyle = '#4a3a8a'; g.fillRect(26, 8, 4, 6);
        g.fillStyle = '#8a3030'; g.fillRect(27, 8, 2, 6);
        g.fillStyle = '#e8c090'; g.fillRect(27, 7, 2, 1);
        // Table (long white cloth)
        g.fillStyle = '#f0e8d0'; g.fillRect(2, 15, 52, 3);
        g.fillStyle = '#d8d0b8'; g.fillRect(2, 18, 52, 1);
        g.fillStyle = '#c0b8a0'; g.fillRect(2, 19, 52, 1);
        // Figures — 4 groups of 3
        var figColors = ['#8a2020','#2a5a2a','#6a4a20','#4a2a6a','#2a4a6a','#6a2a2a','#5a4a20','#2a3a5a','#6a3a4a','#3a5a3a','#5a2a4a','#4a5a2a'];
        for (var fi = 0; fi < 6; fi++) {
          var lx = 3 + fi * 4;
          g.fillStyle = figColors[fi]; g.fillRect(lx, 9, 3, 6);
          g.fillStyle = '#e8c090'; g.fillRect(lx, 8, 3, 1);
          var rx = 31 + fi * 4;
          g.fillStyle = figColors[11-fi]; g.fillRect(rx, 9, 3, 6);
          g.fillStyle = '#e8c090'; g.fillRect(rx, 8, 3, 1);
        }
        // Plates and bread
        g.fillStyle = '#fff';
        for (var pi = 0; pi < 14; pi++) g.fillRect(4 + pi * 4, 16, 2, 1);
      },
      tree_of_life: function () {
        // Klimt — wide golden frieze, spiraling tree branches
        g.fillStyle = '#c9a800'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#b09000'; g.fillRect(0, 0, W, 6);
        g.fillStyle = '#a08000'; g.fillRect(0, 20, W, 4);
        // Tree trunk
        g.fillStyle = '#5a3a10'; g.fillRect(26, 18, 4, 6);
        // Main branches (wide spiraling)
        g.fillStyle = '#6a4a20';
        g.fillRect(10, 10, 36, 2);
        g.fillRect(6, 8, 6, 2); g.fillRect(44, 8, 6, 2);
        g.fillRect(4, 6, 4, 2); g.fillRect(48, 6, 4, 2);
        g.fillRect(14, 6, 3, 4); g.fillRect(39, 6, 3, 4);
        g.fillRect(22, 4, 3, 6); g.fillRect(31, 4, 3, 6);
        // Spiral curl details
        g.fillStyle = '#8a6a30';
        g.fillRect(2, 5, 3, 3); g.fillRect(51, 5, 3, 3);
        g.fillRect(8, 4, 2, 2); g.fillRect(46, 4, 2, 2);
        // Gold leaf dots (scattered)
        g.fillStyle = '#ffd54f';
        var dots = [[6,3],[12,2],[18,1],[24,2],[30,1],[36,2],[42,3],[48,2],[10,6],[16,5],[22,8],[34,8],[40,6],[46,5],[8,12],[14,14],[20,12],[36,12],[42,14],[48,12]];
        for (var di = 0; di < dots.length; di++) g.fillRect(dots[di][0], dots[di][1], 2, 2);
        // Ground meadow
        g.fillStyle = '#4a8a3a'; g.fillRect(0, 22, W, 2);
        g.fillStyle = '#3a6a2a'; g.fillRect(0, 21, 18, 1); g.fillRect(38, 21, 18, 1);
        // Figures at base (woman left, woman right)
        g.fillStyle = '#d4a800'; g.fillRect(8, 14, 4, 7); g.fillRect(44, 14, 4, 7);
        g.fillStyle = '#e8c090'; g.fillRect(9, 13, 2, 1); g.fillRect(45, 13, 2, 1);
      },
      grande_jatte: function () {
        // Seurat — pointillist park, figures, Sunday afternoon
        // "靠近看只是孤獨色塊，退遠看是人群熙攘的公園"
        g.fillStyle = '#5a8a4a'; g.fillRect(0, 0, W, H);
        // Sky
        g.fillStyle = '#8ab0d0'; g.fillRect(0, 0, W, 8);
        g.fillStyle = '#9ac0e0'; g.fillRect(0, 2, W, 4);
        // Trees (dark masses)
        g.fillStyle = '#2a5a2a'; g.fillRect(0, 2, 10, 12); g.fillRect(46, 3, 10, 10);
        g.fillStyle = '#3a6a3a'; g.fillRect(2, 4, 6, 8); g.fillRect(48, 5, 6, 7);
        // Water (right side, Seine)
        g.fillStyle = '#4a7a9a'; g.fillRect(38, 8, 18, 6);
        g.fillStyle = 'rgba(120,180,220,0.3)'; g.fillRect(40, 10, 14, 1);
        // Grass (foreground)
        g.fillStyle = '#4a8a3a'; g.fillRect(0, 14, 40, 10);
        g.fillStyle = '#3a7a2a'; g.fillRect(0, 18, W, 6);
        // Pointillist texture (scattered color dots — Seurat's signature)
        g.fillStyle = 'rgba(255,220,100,0.3)';
        var sunDots = [[4,10],[12,12],[20,14],[28,10],[36,12],[8,16],[16,18],[24,16],[32,18],[40,14],[48,16]];
        for (var sd = 0; sd < sunDots.length; sd++) g.fillRect(sunDots[sd][0], sunDots[sd][1], 1, 1);
        // Figures (iconic silhouettes)
        // Woman with parasol (center-right)
        g.fillStyle = '#2a2030'; g.fillRect(28, 10, 3, 8);
        g.fillStyle = '#4a3040'; g.fillRect(27, 12, 5, 5);
        g.fillRect(28, 8, 3, 2); // parasol
        g.fillRect(27, 8, 5, 1);
        // Man with top hat (left)
        g.fillStyle = '#1a1a2a'; g.fillRect(14, 10, 3, 7);
        g.fillRect(14, 9, 3, 1); g.fillRect(13, 10, 5, 1); // hat
        // Seated figures
        g.fillStyle = '#6a4a3a'; g.fillRect(8, 14, 3, 4);
        g.fillStyle = '#8a6050'; g.fillRect(20, 13, 3, 5);
        // Child
        g.fillStyle = '#eee'; g.fillRect(34, 14, 2, 4);
        // Dog
        g.fillStyle = '#3a2a1a'; g.fillRect(36, 16, 3, 2);
        // Sailboat on water
        g.fillStyle = '#fff'; g.fillRect(44, 6, 1, 3);
        g.fillStyle = '#8a6040'; g.fillRect(43, 9, 3, 1);
      }
    };
    if (painters[key]) painters[key]();
    return c;
  }

  function gallerySelectPainting(archetype) {
    return ARCHETYPE_PAINTINGS[archetype] || ARCHETYPE_PAINTINGS['default'];
  }

  function galleryGetCanvas(key) {
    if (!gallery.canvases[key]) {
      gallery.canvases[key] = renderPainting(key);
    }
    return gallery.canvases[key];
  }

  function galleryGetColor(key) {
    var data = PAINTING_DATA[key];
    return data ? data.color : { r: 40, g: 30, b: 20 };
  }

  // ── Metallic frame with specular highlights ──
  function drawGalleryFrame(ctx, time) {
    var fx = gallery.frameX, fy = gallery.frameY;
    var fw = gallery.frameW, fh = gallery.frameH;

    // Base frame (dark burnished gold)
    ctx.fillStyle = '#3a2818';
    ctx.fillRect(fx, fy, fw, fh);

    // Frame bevels — outer edge
    // Top + left: light catches = warm gold highlight
    var specular = 0.15 + 0.05 * Math.sin(time / 3000);
    ctx.fillStyle = 'rgba(200,170,100,' + specular.toFixed(3) + ')';
    ctx.fillRect(fx, fy, fw, 2);         // top edge
    ctx.fillRect(fx, fy, 2, fh);         // left edge
    // Bottom + right: shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(fx, fy + fh - 2, fw, 2); // bottom
    ctx.fillRect(fx + fw - 2, fy, 2, fh); // right

    // Inner bevel (second ridge)
    ctx.fillStyle = 'rgba(180,150,80,' + (specular * 0.6).toFixed(3) + ')';
    ctx.fillRect(fx + 2, fy + 2, fw - 4, 1);  // inner top
    ctx.fillRect(fx + 2, fy + 2, 1, fh - 4);  // inner left
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(fx + 2, fy + fh - 3, fw - 4, 1); // inner bottom
    ctx.fillRect(fx + fw - 3, fy + 2, 1, fh - 4); // inner right

    // Routed groove (dark channel between frame and painting)
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(fx + 3, fy + 3, fw - 6, 1);
    ctx.fillRect(fx + 3, fy + 3, 1, fh - 6);
    ctx.fillRect(fx + 3, fy + fh - 4, fw - 6, 1);
    ctx.fillRect(fx + fw - 4, fy + 3, 1, fh - 6);

    // Corner rosettes (4 brass ornaments)
    var corners = [[fx+1, fy+1], [fx+fw-2, fy+1], [fx+1, fy+fh-2], [fx+fw-2, fy+fh-2]];
    ctx.fillStyle = 'rgba(220,180,80,' + (specular * 0.8).toFixed(3) + ')';
    for (var ci = 0; ci < corners.length; ci++) {
      ctx.fillRect(corners[ci][0], corners[ci][1], 1, 1);
    }

    // Specular hot spot (simulates pendant light reflection on gold frame)
    var hotX = fx + fw * 0.35 + Math.sin(time / 5000) * 4;
    var hotAlpha = 0.08 + 0.04 * Math.sin(time / 2000);
    ctx.fillStyle = 'rgba(255,240,200,' + hotAlpha.toFixed(3) + ')';
    ctx.fillRect(Math.round(hotX), fy, 8, 2);
  }

  // ── Global Illumination: painting color bleeds into cafe ──
  function drawGalleryGI(ctx, time) {
    var c = gallery.dominantColor;
    if (!c) return;
    // Subtle color wash on floor below the painting (2 tile radius)
    var giPulse = 0.02 + 0.008 * Math.sin(time / 4000);
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + giPulse.toFixed(3) + ')';
    // Floor area below painting (rows 1-3, cols 6-9)
    ctx.fillRect(6 * T, 1 * T, 4 * T, 3 * T);
    // Wider but weaker wash (rows 3-6)
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (giPulse * 0.4).toFixed(3) + ')';
    ctx.fillRect(5 * T, 3 * T, 6 * T, 3 * T);
    // Cruz shoulder edge light (bar area)
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (giPulse * 0.6).toFixed(3) + ')';
    ctx.fillRect(7 * T + 8, 2 * T, T, T);
  }

  // ── Tyndall God Rays: light beam crossing the painting ──
  function drawGodRays(ctx, time) {
    if (isNight()) return; // Only during daytime
    // Light enters from window at tile (5,0) and falls diagonally across painting
    var rayAlpha = 0.04 + 0.015 * Math.sin(time / 3500);
    ctx.save();
    // Diagonal beam from upper-left window toward painting
    ctx.fillStyle = 'rgba(255,240,200,' + rayAlpha.toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(6 * T, 0);
    ctx.lineTo(6 * T + 12, 0);
    ctx.lineTo(9 * T, 4 * T);
    ctx.lineTo(8 * T + 16, 4 * T);
    ctx.closePath();
    ctx.fill();
    // Second thinner beam
    ctx.fillStyle = 'rgba(255,240,200,' + (rayAlpha * 0.5).toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(5 * T + 16, 0);
    ctx.lineTo(5 * T + 24, 0);
    ctx.lineTo(8 * T + 8, 3 * T);
    ctx.lineTo(7 * T + 24, 3 * T);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawDynamicGallery(ctx, time) {
    // Get visitor archetype from CafeInteractions, URL ref, or default
    var cafeState = (window.CafeInteractions) ? window.CafeInteractions.getState() : null;
    var archetype = (cafeState && cafeState.archetype) ? cafeState.archetype : 'default';

    // Check URL ref for Threads integration
    if (archetype === 'default' && !gallery._refChecked) {
      gallery._refChecked = true;
      try {
        var params = new URLSearchParams(window.location.search);
        var ref = params.get('ref');
        if (ref === 'threads_vangogh') archetype = 'creative_anxiety';
        else if (ref === 'threads_seurat') archetype = 'overwhelmed';
        else if (ref === 'threads_klimt') archetype = 'dreamer';
        // Store for CafeInteractions to pick up
        if (archetype !== 'default' && window.CafeInteractions) {
          var st = window.CafeInteractions.getState();
          if (st) st.archetype = archetype;
        }
      } catch (e) { /* URL parsing failed, use default */ }
    }

    // Check if archetype changed → trigger crossfade
    if (archetype !== gallery.lastArchetype) {
      var newKey = gallerySelectPainting(archetype);
      if (newKey !== gallery.current) {
        gallery.next = newKey;
        gallery.fadeStart = time;
        // Update target GI color
        gallery.targetColor = galleryGetColor(newKey);
      }
      gallery.lastArchetype = archetype;
    }

    // Initialize with default painting if none set
    if (!gallery.current) {
      gallery.current = gallerySelectPainting(archetype);
      gallery.dominantColor = galleryGetColor(gallery.current);
    }

    // Draw metallic frame
    drawGalleryFrame(ctx, time);

    // Calculate crossfade alpha
    var fadeProgress = 1;
    if (gallery.next && gallery.fadeStart > 0) {
      fadeProgress = Math.min(1, (time - gallery.fadeStart) / gallery.fadeDuration);
    }

    var oldAlpha = ctx.globalAlpha;

    // Draw current painting (fading out if transitioning)
    if (gallery.current) {
      var currentCanvas = galleryGetCanvas(gallery.current);
      if (gallery.next) {
        ctx.globalAlpha = 1 - fadeProgress;
      }
      ctx.drawImage(currentCanvas, gallery.artX, gallery.artY);
    }

    // Draw next painting (fading in)
    if (gallery.next) {
      var nextCanvas = galleryGetCanvas(gallery.next);
      ctx.globalAlpha = fadeProgress;
      ctx.drawImage(nextCanvas, gallery.artX, gallery.artY);

      // Interpolate GI color during crossfade
      if (gallery.targetColor) {
        var cur = gallery.dominantColor;
        var tgt = gallery.targetColor;
        gallery.dominantColor = {
          r: Math.round(cur.r + (tgt.r - cur.r) * fadeProgress),
          g: Math.round(cur.g + (tgt.g - cur.g) * fadeProgress),
          b: Math.round(cur.b + (tgt.b - cur.b) * fadeProgress)
        };
      }

      // Crossfade complete
      if (fadeProgress >= 1) {
        gallery.current = gallery.next;
        gallery.dominantColor = galleryGetColor(gallery.current);
        gallery.next = null;
        gallery.fadeStart = 0;
        gallery.targetColor = null;
      }
    }

    ctx.globalAlpha = oldAlpha;

    // God rays crossing the painting
    drawGodRays(ctx, time);

    // Global illumination — painting color bleeds into cafe
    drawGalleryGI(ctx, time);

    // Warm pendant glow on the frame surface
    var glowPulse = 0.03 + 0.01 * Math.sin(time / 2500);
    ctx.fillStyle = 'rgba(255,200,120,' + glowPulse.toFixed(3) + ')';
    ctx.fillRect(gallery.artX, gallery.artY, gallery.artW, gallery.artH);
  }

  // ═══════════════════════════════════════════════════════════
  // 無極視覺轉場 (Wuji Visual Transition)
  // 五行 Canvas → 去色 → 粒子消散 → 純黑 → 白色發光字
  // ═══════════════════════════════════════════════════════════

  var wujiVisual = {
    active: false,
    phase: 'none',     // none → grayscale → dissolve → void → text
    startTime: 0,
    particles: [],
    textAlpha: 0,
    snapshot: null,     // ImageData of last frame before transition
  };

  function captureSnapshot(ctx) {
    try {
      var w = ctx.canvas.width, h = ctx.canvas.height;
      wujiVisual.snapshot = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      wujiVisual.snapshot = null;
    }
  }

  function startWujiTransition(ctx) {
    if (wujiVisual.active) return;
    captureSnapshot(ctx);
    wujiVisual.active = true;
    wujiVisual.phase = 'grayscale';
    wujiVisual.startTime = performance.now();
    wujiVisual.particles = [];
    wujiVisual.textAlpha = 0;

    // Generate dissolve particles from snapshot
    if (wujiVisual.snapshot) {
      var data = wujiVisual.snapshot.data;
      var w = wujiVisual.snapshot.width;
      var h = wujiVisual.snapshot.height;
      var step = 4; // sample every 4px for performance
      for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
          var i = (y * w + x) * 4;
          var r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
          if (a < 30) continue;
          // Grayscale luminance
          var lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          wujiVisual.particles.push({
            x: x, y: y,
            vx: (Math.random() - 0.5) * 2,
            vy: -Math.random() * 3 - 0.5,
            r: lum, g: lum, b: lum,
            alpha: a / 255,
            life: 1.0,
            decay: 0.005 + Math.random() * 0.015,
            size: step,
          });
        }
      }
    }
  }

  function drawWujiTransition(ctx, time) {
    if (!wujiVisual.active) return false;

    var elapsed = time - wujiVisual.startTime;
    var w = ctx.canvas.width, h = ctx.canvas.height;

    // Phase 1: Grayscale (0-800ms)
    if (wujiVisual.phase === 'grayscale') {
      if (wujiVisual.snapshot) {
        // Draw grayscale version of snapshot
        var imgData = ctx.createImageData(w, h);
        var src = wujiVisual.snapshot.data;
        var dst = imgData.data;
        var progress = Math.min(elapsed / 800, 1);
        for (var i = 0; i < src.length; i += 4) {
          var lum = 0.299 * src[i] + 0.587 * src[i+1] + 0.114 * src[i+2];
          dst[i]   = src[i]   + (lum - src[i])   * progress;
          dst[i+1] = src[i+1] + (lum - src[i+1]) * progress;
          dst[i+2] = src[i+2] + (lum - src[i+2]) * progress;
          dst[i+3] = src[i+3];
        }
        ctx.putImageData(imgData, 0, 0);
      }
      if (elapsed > 800) {
        wujiVisual.phase = 'dissolve';
        wujiVisual.startTime = time;
      }
      return true;
    }

    // Phase 2: Particle dissolve (0-3000ms)
    if (wujiVisual.phase === 'dissolve') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      var alive = 0;
      for (var p = 0; p < wujiVisual.particles.length; p++) {
        var pt = wujiVisual.particles[p];
        if (pt.life <= 0) continue;
        alive++;
        pt.x += pt.vx;
        pt.y += pt.vy;
        pt.vy -= 0.02; // float upward
        pt.life -= pt.decay;
        var a = pt.alpha * pt.life;
        if (a < 0.01) continue;
        ctx.fillStyle = 'rgba(' + pt.r + ',' + pt.g + ',' + pt.b + ',' + a.toFixed(3) + ')';
        ctx.fillRect(pt.x, pt.y, pt.size, pt.size);
      }
      if (alive === 0 || elapsed > 3000) {
        wujiVisual.phase = 'void';
        wujiVisual.startTime = time;
      }
      return true;
    }

    // Phase 3: Pure void → glowing text
    if (wujiVisual.phase === 'void' || wujiVisual.phase === 'text') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      // Text fade in after 500ms of void
      var textElapsed = time - wujiVisual.startTime;
      if (textElapsed > 500) {
        wujiVisual.phase = 'text';
        wujiVisual.textAlpha = Math.min((textElapsed - 500) / 2000, 0.9);

        // Glowing white text
        var fontSize = Math.max(8, Math.floor(w / 40));
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = fontSize + 'px monospace';

        // Glow layers
        var glow = wujiVisual.textAlpha * 0.3;
        ctx.shadowColor = 'rgba(255,255,255,' + glow.toFixed(2) + ')';
        ctx.shadowBlur = 20;
        ctx.fillStyle = 'rgba(255,255,255,' + wujiVisual.textAlpha.toFixed(2) + ')';

        var cx = w / 2, cy = h / 2;
        ctx.fillText('五行已退。', cx, cy - fontSize * 0.8);
        ctx.fillText('無極在此。', cx, cy + fontSize * 0.8);

        // English subtitle, smaller
        ctx.font = Math.floor(fontSize * 0.6) + 'px monospace';
        ctx.fillStyle = 'rgba(200,200,220,' + (wujiVisual.textAlpha * 0.5).toFixed(2) + ')';
        ctx.shadowBlur = 10;
        ctx.fillText('The elements fade. Wuji remains.', cx, cy + fontSize * 2.5);

        ctx.restore();
      }
      return true;
    }

    return false;
  }

  function endWujiTransition() {
    wujiVisual.active = false;
    wujiVisual.phase = 'none';
    wujiVisual.particles = [];
    wujiVisual.snapshot = null;
  }

  // ── Public API ───────────────────────────────────────────────
  window.CafeAmbience = {
    init: function (npc, map) {
      npcData = npc; mapData = map; mood = computeMood();
    },
    draw: function (ctx, time) { drawAll(ctx, time); },
    updateData: function (npc) { npcData = npc; mood = computeMood(); },
    getMood: function () { return mood; },
    // Gallery API — external control for archetype changes
    setArchetype: function (archetype) {
      gallery.lastArchetype = null; // Force re-evaluation
      if (window.CafeInteractions && window.CafeInteractions.getState) {
        var state = window.CafeInteractions.getState();
        if (state) state.archetype = archetype;
      }
    },
    getGalleryState: function () {
      return {
        current: gallery.current,
        next: gallery.next,
        archetype: gallery.lastArchetype,
        dominantColor: gallery.dominantColor,
        painting: gallery.current ? PAINTING_DATA[gallery.current] : null
      };
    },
    // 無極視覺轉場 API
    startWujiTransition: startWujiTransition,
    drawWujiTransition: drawWujiTransition,
    endWujiTransition: endWujiTransition,
    isWujiActive: function () { return wujiVisual.active; },
    getWujiPhase: function () { return wujiVisual.phase; }
  };
})();
