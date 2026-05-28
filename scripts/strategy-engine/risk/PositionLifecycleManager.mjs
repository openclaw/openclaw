function asPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function asBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function asNonNegativeInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function asTimeString(value, fallback) {
  const normalized = String(value ?? "").trim();
  return /^\d{2}:\d{2}$/u.test(normalized) ? normalized : fallback;
}

function asEnumString(value, allowed, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function currentMinutesInTimezone(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function closeTimeMinutes(closeTime) {
  const [hour, minute] = closeTime.split(":").map((part) => Number(part));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

function formatMinutesAsTime(totalMinutes) {
  const bounded = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(bounded / 60)
    .toString()
    .padStart(2, "0");
  const minute = (bounded % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function buildStateKey(signal) {
  return `${signal.strategy ?? ""}|${signal.instrument ?? ""}`;
}

function positionSide(positionQty) {
  if (positionQty > 0) {
    return "long";
  }
  if (positionQty < 0) {
    return "short";
  }
  return "flat";
}

function signalOpenSide(direction) {
  if (direction === "buy") {
    return "long";
  }
  if (direction === "sell") {
    return "short";
  }
  return "flat";
}

function isCloseDirection(direction) {
  return direction === "close_long" || direction === "close_short";
}

function computeUnrealizedPnlPct(params) {
  const entryPrice = Number(params.entryPrice ?? 0);
  const currentPrice = Number(params.currentPrice ?? 0);
  const side = params.positionSide;
  if (!entryPrice || !currentPrice || side === "flat") {
    return 0;
  }
  if (side === "long") {
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }
  return ((entryPrice - currentPrice) / entryPrice) * 100;
}

function resolveNow(params, signalTime) {
  const candidate = params.now ?? signalTime ?? Date.now();
  const resolved = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isNaN(resolved.getTime()) ? new Date() : resolved;
}

function isTrendIntact(strategy, positionSideValue, currentPrice) {
  const history = strategy?._priceHistory;
  if (!Array.isArray(history) || history.length < 3) {
    return true;
  }
  const closes = history
    .slice(-3)
    .map((bar) => Number(bar?.close ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < 2 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return true;
  }
  const prevClose = closes[closes.length - 1];
  const prevPrevClose = closes[closes.length - 2] ?? prevClose;
  if (positionSideValue === "long") {
    return currentPrice >= prevClose && prevClose >= prevPrevClose;
  }
  if (positionSideValue === "short") {
    return currentPrice <= prevClose && prevClose <= prevPrevClose;
  }
  return true;
}

function isPreviousAddOnProfitable(state, positionSideValue, currentPrice) {
  const addOnEntry = Number(state.lastAddOnEntryPrice ?? 0);
  if (!addOnEntry || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return true;
  }
  if (positionSideValue === "long") {
    return currentPrice > addOnEntry;
  }
  if (positionSideValue === "short") {
    return currentPrice < addOnEntry;
  }
  return true;
}

export class PositionLifecycleManager {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.defaultHoldingMode = config.defaultHoldingMode ?? "day_trade";
    this.session = {
      flatBeforeClose: asBoolean(config.session?.flatBeforeClose, true),
      closeTime: asTimeString(config.session?.closeTime, "13:25"),
      tz: String(config.session?.tz ?? "Asia/Taipei"),
      forceFlatPolicy: asEnumString(config.session?.forceFlatPolicy, ["always", "smart"], "always"),
      graceMinutes: asNonNegativeInteger(config.session?.graceMinutes, 0),
      smartMinProfitPct: asPositiveNumber(config.session?.smartMinProfitPct) ?? 0.6,
      smartRequireTrendIntact: asBoolean(config.session?.smartRequireTrendIntact, true),
      blockNewEntryBeforeCloseMinutes: asNonNegativeInteger(
        config.session?.blockNewEntryBeforeCloseMinutes,
        5,
      ),
      blockAddOnBeforeCloseMinutes: asNonNegativeInteger(
        config.session?.blockAddOnBeforeCloseMinutes,
        5,
      ),
    };
    this.holdOvernight = {
      enabled: config.holdOvernight?.enabled !== false,
      minProfitPct: asPositiveNumber(config.holdOvernight?.minProfitPct) ?? 1.2,
      minBarsHeld: asNonNegativeInteger(config.holdOvernight?.minBarsHeld, 5),
      maxBarsHeld: asNonNegativeInteger(config.holdOvernight?.maxBarsHeld, 240),
      moveStopToBreakeven: asBoolean(config.holdOvernight?.moveStopToBreakeven, false),
    };
    this.addOn = {
      enabled: config.addOn?.enabled !== false,
      minProfitPct: asPositiveNumber(config.addOn?.minProfitPct) ?? 0.6,
      scaleFactor: asPositiveNumber(config.addOn?.scaleFactor) ?? 0.5,
      maxAddCount: asNonNegativeInteger(config.addOn?.maxAddCount, 2),
      requireTrendIntact: asBoolean(config.addOn?.requireTrendIntact, false),
      requirePrevAddProfit: asBoolean(config.addOn?.requirePrevAddProfit, false),
    };
    this._state = new Map();
  }

  evaluate(params) {
    if (!this.enabled) {
      return { allow: true, signal: params.signal, reason: "disabled" };
    }
    const signal = { ...params.signal };
    const key = buildStateKey(signal);
    const state = this._state.get(key) ?? {
      addCount: 0,
      barsHeld: 0,
      holdMode: this.defaultHoldingMode,
      lastAddOnEntryPrice: 0,
      breakevenArmed: false,
      breakevenPrice: 0,
    };

    const direction = String(signal.direction ?? "");
    const currentPrice = Number(signal.price ?? params.strategy?.lastBar?.()?.close ?? 0);
    const entryPrice = Number(params.strategy?._entryPrice ?? 0);
    const posQty = Number(params.strategy?._position ?? 0);
    const posSide = positionSide(posQty);
    const pnlPct = computeUnrealizedPnlPct({
      entryPrice,
      currentPrice,
      positionSide: posSide,
    });

    if (posSide === "flat") {
      state.addCount = 0;
      state.barsHeld = 0;
      state.holdMode = this.defaultHoldingMode;
      state.lastAddOnEntryPrice = 0;
      state.breakevenArmed = false;
      state.breakevenPrice = 0;
    } else {
      state.barsHeld += 1;
    }

    const now = resolveNow(params, signal.time);
    const nowMinutes = currentMinutesInTimezone(now, this.session.tz);
    const closeMinutes = closeTimeMinutes(this.session.closeTime);
    const hardCloseMinutes =
      closeMinutes != null ? closeMinutes + Math.max(0, this.session.graceMinutes) : null;
    const newEntryBlockStartMinutes =
      closeMinutes != null
        ? closeMinutes - Math.max(0, this.session.blockNewEntryBeforeCloseMinutes)
        : null;
    const addOnBlockStartMinutes =
      closeMinutes != null
        ? closeMinutes - Math.max(0, this.session.blockAddOnBeforeCloseMinutes)
        : null;
    const shouldForceFlat =
      this.session.flatBeforeClose &&
      state.holdMode === "day_trade" &&
      posSide !== "flat" &&
      nowMinutes != null &&
      closeMinutes != null &&
      nowMinutes >= closeMinutes;
    if (shouldForceFlat) {
      const withinSmartGrace =
        this.session.forceFlatPolicy === "smart" &&
        hardCloseMinutes != null &&
        nowMinutes < hardCloseMinutes;
      if (isCloseDirection(direction)) {
        signal.holdingMode = state.holdMode;
        signal.dayTradeMode = state.holdMode;
        this._state.set(key, state);
        return {
          allow: true,
          signal,
          reason: `eod_close_signal pass_through close_time=${this.session.closeTime} tz=${this.session.tz}`,
        };
      }
      if (withinSmartGrace) {
        const trendOk =
          !this.session.smartRequireTrendIntact ||
          isTrendIntact(params.strategy, posSide, currentPrice);
        const pnlOk = pnlPct >= this.session.smartMinProfitPct;
        if (trendOk && pnlOk) {
          this._state.set(key, state);
          return {
            allow: false,
            signal,
            reason:
              `eod_defer_no_rush pnlPct=${pnlPct.toFixed(2)}% ` +
              `hard_close=${formatMinutesAsTime(hardCloseMinutes)} tz=${this.session.tz}`,
          };
        }
      }
      signal.direction = posSide === "long" ? "close_long" : "close_short";
      signal.qty = Math.max(1, Math.floor(Math.abs(posQty)));
      signal.holdingMode = state.holdMode;
      signal.dayTradeMode = state.holdMode;
      signal.lifecycleAction = "eod_force_flat";
      state.addCount = 0;
      signal.reason = [String(signal.reason ?? "").trim(), "eod_force_flat"]
        .filter(Boolean)
        .join(" | ");
      this._state.set(key, state);
      return {
        allow: true,
        signal,
        reason: `eod_force_flat close_time=${this.session.closeTime} tz=${this.session.tz}`,
      };
    }

    if (isCloseDirection(direction)) {
      const allowHold =
        this.holdOvernight.enabled &&
        pnlPct >= this.holdOvernight.minProfitPct &&
        state.barsHeld >= this.holdOvernight.minBarsHeld &&
        (this.holdOvernight.maxBarsHeld <= 0 || state.barsHeld <= this.holdOvernight.maxBarsHeld);
      if (allowHold) {
        state.holdMode = "overnight";
        if (this.holdOvernight.moveStopToBreakeven && entryPrice > 0) {
          state.breakevenArmed = true;
          state.breakevenPrice = entryPrice;
        }
        this._state.set(key, state);
        const reasonSuffix =
          state.breakevenArmed && state.breakevenPrice > 0
            ? ` move_stop_to_breakeven=${state.breakevenPrice}`
            : "";
        return {
          allow: false,
          signal,
          reason: `hold_overnight pnlPct=${pnlPct.toFixed(2)}%${reasonSuffix}`,
        };
      }
      state.addCount = 0;
      state.lastAddOnEntryPrice = 0;
      state.holdMode = this.defaultHoldingMode;
      state.breakevenArmed = false;
      state.breakevenPrice = 0;
      signal.holdingMode = state.holdMode;
      signal.dayTradeMode = state.holdMode;
      this._state.set(key, state);
      return { allow: true, signal, reason: "close_allowed" };
    }

    const openSide = signalOpenSide(direction);
    const shouldBlockNewEntryNearClose =
      openSide !== "flat" &&
      posSide === "flat" &&
      state.holdMode === "day_trade" &&
      this.session.flatBeforeClose &&
      nowMinutes != null &&
      newEntryBlockStartMinutes != null &&
      nowMinutes >= newEntryBlockStartMinutes;
    if (shouldBlockNewEntryNearClose) {
      return {
        allow: false,
        signal,
        reason:
          `entry_blocked_eod_window start=${formatMinutesAsTime(newEntryBlockStartMinutes)} ` +
          `close_time=${this.session.closeTime} tz=${this.session.tz}`,
      };
    }

    if (openSide !== "flat" && posSide === openSide && Math.abs(posQty) > 0) {
      const shouldBlockAddOnNearClose =
        state.holdMode === "day_trade" &&
        this.session.flatBeforeClose &&
        nowMinutes != null &&
        addOnBlockStartMinutes != null &&
        nowMinutes >= addOnBlockStartMinutes;
      if (shouldBlockAddOnNearClose) {
        return {
          allow: false,
          signal,
          reason:
            `addon_blocked_eod_window start=${formatMinutesAsTime(addOnBlockStartMinutes)} ` +
            `close_time=${this.session.closeTime} tz=${this.session.tz}`,
        };
      }
      if (!this.addOn.enabled) {
        return { allow: false, signal, reason: "addon_disabled" };
      }
      if (pnlPct < this.addOn.minProfitPct) {
        return { allow: false, signal, reason: `addon_blocked pnlPct=${pnlPct.toFixed(2)}%` };
      }
      if (state.addCount >= this.addOn.maxAddCount) {
        return { allow: false, signal, reason: "addon_blocked max_add_count" };
      }
      if (this.addOn.requireTrendIntact && !isTrendIntact(params.strategy, posSide, currentPrice)) {
        return { allow: false, signal, reason: "addon_blocked trend_not_intact" };
      }
      if (
        this.addOn.requirePrevAddProfit &&
        state.addCount > 0 &&
        !isPreviousAddOnProfitable(state, posSide, currentPrice)
      ) {
        return { allow: false, signal, reason: "addon_blocked prev_add_not_profitable" };
      }
      const baseQty = Math.max(1, Number(signal.qty ?? 1));
      signal.qty = Math.max(1, Math.floor(baseQty * this.addOn.scaleFactor));
      signal.holdingMode = state.holdMode;
      signal.dayTradeMode = state.holdMode;
      state.addCount += 1;
      state.lastAddOnEntryPrice = currentPrice;
      signal.reason = [String(signal.reason ?? "").trim(), `addOn count=${state.addCount}`]
        .filter(Boolean)
        .join(" | ");
      this._state.set(key, state);
      return { allow: true, signal, reason: `addon_allowed count=${state.addCount}` };
    }

    signal.holdingMode = state.holdMode;
    signal.dayTradeMode = state.holdMode;
    this._state.set(key, state);
    return { allow: true, signal, reason: "open_allowed" };
  }
}
