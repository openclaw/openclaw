const SETTINGS_DESK = "moltbot";
const SETTINGS_BUCKET = "tlon";
function parseChannelRules(value) {
  if (!value) {
    return void 0;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (isChannelRulesObject(parsed)) {
        return parsed;
      }
    } catch {
      return void 0;
    }
  }
  if (isChannelRulesObject(value)) {
    return value;
  }
  return void 0;
}
function parseSettingsResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const desk = raw;
  const bucket = desk[SETTINGS_BUCKET];
  if (!bucket || typeof bucket !== "object") {
    return {};
  }
  const settings = bucket;
  return {
    groupChannels: Array.isArray(settings.groupChannels) ? settings.groupChannels.filter((x) => typeof x === "string") : void 0,
    dmAllowlist: Array.isArray(settings.dmAllowlist) ? settings.dmAllowlist.filter((x) => typeof x === "string") : void 0,
    autoDiscover: typeof settings.autoDiscover === "boolean" ? settings.autoDiscover : void 0,
    showModelSig: typeof settings.showModelSig === "boolean" ? settings.showModelSig : void 0,
    autoAcceptDmInvites: typeof settings.autoAcceptDmInvites === "boolean" ? settings.autoAcceptDmInvites : void 0,
    autoAcceptGroupInvites: typeof settings.autoAcceptGroupInvites === "boolean" ? settings.autoAcceptGroupInvites : void 0,
    groupInviteAllowlist: Array.isArray(settings.groupInviteAllowlist) ? settings.groupInviteAllowlist.filter((x) => typeof x === "string") : void 0,
    channelRules: parseChannelRules(settings.channelRules),
    defaultAuthorizedShips: Array.isArray(settings.defaultAuthorizedShips) ? settings.defaultAuthorizedShips.filter((x) => typeof x === "string") : void 0,
    ownerShip: typeof settings.ownerShip === "string" ? settings.ownerShip : void 0,
    pendingApprovals: parsePendingApprovals(settings.pendingApprovals)
  };
}
function isChannelRulesObject(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    return false;
  }
  for (const [, rule] of Object.entries(val)) {
    if (!rule || typeof rule !== "object") {
      return false;
    }
  }
  return true;
}
function parsePendingApprovals(value) {
  if (!value) {
    return void 0;
  }
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return void 0;
    }
  }
  if (!Array.isArray(parsed)) {
    return void 0;
  }
  return parsed.filter((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const obj = item;
    return typeof obj.id === "string" && (obj.type === "dm" || obj.type === "channel" || obj.type === "group") && typeof obj.requestingShip === "string" && typeof obj.timestamp === "number";
  });
}
function parseSettingsEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const evt = event;
  if (evt["put-entry"]) {
    const put = evt["put-entry"];
    if (put.desk !== SETTINGS_DESK || put["bucket-key"] !== SETTINGS_BUCKET) {
      return null;
    }
    return {
      key: String(put["entry-key"] ?? ""),
      value: put.value
    };
  }
  if (evt["del-entry"]) {
    const del = evt["del-entry"];
    if (del.desk !== SETTINGS_DESK || del["bucket-key"] !== SETTINGS_BUCKET) {
      return null;
    }
    return {
      key: String(del["entry-key"] ?? ""),
      value: void 0
    };
  }
  return null;
}
function applySettingsUpdate(current, key, value) {
  const next = { ...current };
  switch (key) {
    case "groupChannels":
      next.groupChannels = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
      break;
    case "dmAllowlist":
      next.dmAllowlist = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
      break;
    case "autoDiscover":
      next.autoDiscover = typeof value === "boolean" ? value : void 0;
      break;
    case "showModelSig":
      next.showModelSig = typeof value === "boolean" ? value : void 0;
      break;
    case "autoAcceptDmInvites":
      next.autoAcceptDmInvites = typeof value === "boolean" ? value : void 0;
      break;
    case "autoAcceptGroupInvites":
      next.autoAcceptGroupInvites = typeof value === "boolean" ? value : void 0;
      break;
    case "groupInviteAllowlist":
      next.groupInviteAllowlist = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
      break;
    case "channelRules":
      next.channelRules = parseChannelRules(value);
      break;
    case "defaultAuthorizedShips":
      next.defaultAuthorizedShips = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
      break;
    case "ownerShip":
      next.ownerShip = typeof value === "string" ? value : void 0;
      break;
    case "pendingApprovals":
      next.pendingApprovals = parsePendingApprovals(value);
      break;
  }
  return next;
}
function createSettingsManager(api, logger) {
  let state = {
    current: {},
    loaded: false
  };
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(state.current);
      } catch (err) {
        logger?.error?.(`[settings] Listener error: ${String(err)}`);
      }
    }
  };
  return {
    /**
     * Get current settings (may be empty if not loaded yet).
     */
    get current() {
      return state.current;
    },
    /**
     * Whether initial settings have been loaded.
     */
    get loaded() {
      return state.loaded;
    },
    /**
     * Load initial settings via scry.
     */
    async load() {
      try {
        const raw = await api.scry("/settings/all.json");
        const allData = raw;
        const deskData = allData?.all?.[SETTINGS_DESK];
        state.current = parseSettingsResponse(deskData ?? {});
        state.loaded = true;
        logger?.log?.(`[settings] Loaded: ${JSON.stringify(state.current)}`);
        return state.current;
      } catch (err) {
        logger?.log?.(`[settings] No settings found (using defaults): ${String(err)}`);
        state.current = {};
        state.loaded = true;
        return state.current;
      }
    },
    /**
     * Subscribe to settings changes.
     */
    async startSubscription() {
      await api.subscribe({
        app: "settings",
        path: "/desk/" + SETTINGS_DESK,
        event: (event) => {
          const update = parseSettingsEvent(event);
          if (!update) {
            return;
          }
          logger?.log?.(`[settings] Update: ${update.key} = ${JSON.stringify(update.value)}`);
          state.current = applySettingsUpdate(state.current, update.key, update.value);
          notify();
        },
        err: (error) => {
          logger?.error?.(`[settings] Subscription error: ${String(error)}`);
        },
        quit: () => {
          logger?.log?.("[settings] Subscription ended");
        }
      });
      logger?.log?.("[settings] Subscribed to settings updates");
    },
    /**
     * Register a listener for settings changes.
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
export {
  createSettingsManager
};
