/**
 * SettingsBridge — iframe ↔ host postMessage communication for config read/write.
 *
 * Usage inside dashboard HTML (iframe):
 *   SettingsBridge.get("trading").then(function(values) { ... });
 *   SettingsBridge.patch("trading", { maxAutoTradeUsd: 200 }).then(function() { ... });
 */
var SettingsBridge = (function () {
  "use strict";

  var _reqId = 0;
  var _pending = {}; // reqId -> { resolve, reject, timer }
  var TIMEOUT_MS = 5000;

  // Listen for responses from host
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object") return;

    if (d.type === "fin-config-patch-result" && d._reqId != null) {
      var p = _pending[d._reqId];
      if (!p) return;
      clearTimeout(p.timer);
      delete _pending[d._reqId];
      if (d.ok) {
        p.resolve(d);
      } else {
        p.reject(new Error(d.error || "Config patch failed"));
      }
    }

    if (d.type === "fin-config-get-result" && d._reqId != null) {
      var g = _pending[d._reqId];
      if (!g) return;
      clearTimeout(g.timer);
      delete _pending[d._reqId];
      if (d.ok) {
        g.resolve(d.values || {});
      } else {
        g.reject(new Error(d.error || "Config get failed"));
      }
    }
  });

  function _send(msg) {
    var id = ++_reqId;
    msg._reqId = id;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete _pending[id];
        reject(new Error("SettingsBridge timeout"));
      }, TIMEOUT_MS);
      _pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.parent.postMessage(msg, "*");
    });
  }

  return {
    /**
     * Read current config values for a financial section.
     * @param {string} section — "trading" | "paperTrading" | "fund" | "backtest" | "evolution" | "all"
     * @returns {Promise<object>} section values
     */
    get: function (section) {
      return _send({ type: "fin-config-get", section: section });
    },

    /**
     * Patch config values (deep merge into financial.<section>).
     * @param {string} section — "trading" | "paperTrading" | "fund" | "backtest" | "evolution"
     * @param {object} values — key/value pairs to merge
     * @returns {Promise<{ok: boolean}>}
     */
    patch: function (section, values) {
      return _send({ type: "fin-config-patch", section: section, values: values });
    },
  };
})();
