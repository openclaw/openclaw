function b(t) {
  return (typeof t == "string" && t.trim()) || void 0;
}
function pe(t) {
  let e = b(t.token),
    n = b(t.bootstrapToken),
    o = b(t.deviceToken),
    i = b(t.password),
    r = b(t.storedToken),
    s = { storedToken: r, storedScopes: t.storedScopes };
  if (t.preferBootstrapToken && n) return { authBootstrapToken: n, authPassword: i, ...s };
  let u = t.pendingDeviceTokenRetry === !0 && !o && !!(e && r && t.trustedDeviceTokenRetry),
    d = o ?? (u || (!(e || i) && (!n || r)) ? r : void 0),
    a = !!(d && !o && r) && d === r,
    l = e ?? d,
    p = !e && !d && !i ? n : void 0;
  return {
    authToken: l,
    authBootstrapToken: p,
    authDeviceToken: u ? r : void 0,
    authPassword: i,
    authApprovalRuntimeToken: b(t.approvalRuntimeToken),
    authAgentRuntimeIdentityToken: b(t.agentRuntimeIdentityToken),
    signatureToken: l ?? p,
    resolvedDeviceToken: d,
    usingStoredDeviceToken: a,
    ...s,
  };
}
function Z(t) {
  let e = {
    token: t.authToken,
    bootstrapToken: t.authBootstrapToken,
    deviceToken: t.authDeviceToken ?? t.resolvedDeviceToken,
    password: t.authPassword,
    approvalRuntimeToken: t.authApprovalRuntimeToken,
    agentRuntimeIdentityToken: t.authAgentRuntimeIdentityToken,
  };
  return Object.values(e).some(Boolean) ? e : void 0;
}
function fe(t) {
  return (
    t.requestedScopes ??
    (t.usingStoredDeviceToken && t.storedScopes?.length ? t.storedScopes : [...t.defaultScopes])
  );
}
function he(t) {
  if (typeof t != "string") return "";
  let e = t.trim();
  return e ? e.replace(/[A-Z]/g, (n) => String.fromCharCode(n.charCodeAt(0) + 32)) : "";
}
function ye(t) {
  let e = t.scopes.join(","),
    n = t.token ?? "",
    o = he(t.platform),
    i = he(t.deviceFamily);
  return [
    "v3",
    t.deviceId,
    t.clientId,
    t.clientMode,
    t.role,
    e,
    String(t.signedAtMs),
    n,
    t.nonce,
    o,
    i,
  ].join("|");
}
var j = class {
  constructor(e) {
    this.deps = e;
  }
  async buildPlan(e) {
    let n = await this.deps.loadIdentity(),
      o = n
        ? await this.deps.tokenStore.load({
            clientId: e.client.id,
            deviceId: n.deviceId,
            role: e.role,
          })
        : null,
      i = o?.token,
      r = pe({
        token: e.token,
        bootstrapToken: e.bootstrapToken,
        password: e.password,
        storedToken: i,
        storedScopes: o?.scopes,
        pendingDeviceTokenRetry: e.pendingDeviceTokenRetry,
        trustedDeviceTokenRetry: e.trustedDeviceTokenRetry,
        preferBootstrapToken: e.preferBootstrapToken,
      }),
      { usingStoredDeviceToken: s } = r,
      u = fe({
        requestedScopes:
          r.authBootstrapToken && e.bootstrapScopes ? [...e.bootstrapScopes] : void 0,
        usingStoredDeviceToken: s,
        storedScopes: r.storedScopes,
        defaultScopes: e.defaultScopes,
      });
    if (!n)
      return {
        clientId: e.client.id,
        role: e.role,
        identity: n,
        selectedAuth: r,
        scopes: u,
        auth: Z(r),
      };
    let d = this.deps.nowMs?.() ?? Date.now(),
      a = e.nonce ?? "",
      { authBootstrapToken: l, signatureToken: p } = r,
      f = null;
    l ? (f = l) : p && (f = p);
    let y = ye({
      deviceId: n.deviceId,
      clientId: e.client.id,
      clientMode: e.client.mode,
      role: e.role,
      scopes: u,
      signedAtMs: d,
      token: f,
      nonce: a,
      platform: e.client.platform,
      deviceFamily: e.client.deviceFamily,
    });
    return {
      clientId: e.client.id,
      role: e.role,
      identity: n,
      selectedAuth: r,
      scopes: u,
      auth: Z(r),
      device: {
        id: n.deviceId,
        publicKey: n.publicKey,
        signature: await n.sign(y),
        signedAt: d,
        nonce: a,
      },
    };
  }
  async acceptHello(e, n) {
    let o = e.auth?.deviceToken?.trim();
    !o ||
      !n.identity ||
      (await this.deps.tokenStore.store({
        clientId: n.clientId,
        deviceId: n.identity.deviceId,
        role: e.auth?.role ?? n.role,
        token: o,
        scopes: e.auth?.scopes ?? [],
      }));
  }
  async clearStoredToken(e) {
    e.identity &&
      (await this.deps.tokenStore.clear({
        clientId: e.clientId,
        deviceId: e.identity.deviceId,
        role: e.role,
      }));
  }
};
function $(t) {
  return !!t && typeof t == "object" && !Array.isArray(t);
}
function L(t) {
  return typeof t == "string" && t.length > 0;
}
function me(t) {
  return typeof t == "number" && Number.isInteger(t) && t >= 0;
}
function Ye(t) {
  return !$(t) ||
    !L(t.code) ||
    !L(t.message) ||
    (t.retryable !== void 0 && typeof t.retryable != "boolean")
    ? !1
    : t.retryAfterMs === void 0 || me(t.retryAfterMs);
}
function Te(t) {
  return !$(t) || t.type !== "event" || !L(t.event) ? !1 : t.seq === void 0 || me(t.seq);
}
function ge(t) {
  return !$(t) || t.type !== "res" || !L(t.id) || typeof t.ok != "boolean"
    ? !1
    : t.error === void 0 || Ye(t.error);
}
function We(t, e) {
  let n = Math.min(t.maxMs, t.initialMs * t.factor ** Math.max(e - 1, 0)),
    o = n * t.jitter * Math.random();
  return Math.min(t.maxMs, Math.round(n + o));
}
async function Ee(t, e, n = {}) {
  if (!Number.isFinite(t) || t <= 0) return;
  let o = Math.min(Math.max(Math.floor(t), 1), 2147e6);
  await new Promise((i, r) => {
    let s = !1,
      u = null,
      d = () => e?.removeEventListener("abort", a),
      a = () => {
        s ||
          ((s = !0),
          u && clearTimeout(u),
          (u = null),
          d(),
          r(new Error("aborted", { cause: e?.reason ?? new Error("aborted") })));
      };
    if ((e?.addEventListener("abort", a, { once: !0 }), e?.aborted)) {
      a();
      return;
    }
    ((u = setTimeout(() => {
      ((s = !0), d(), (u = null), i());
    }, o)),
      n.ref === !1 && u.unref?.(),
      e?.aborted && a());
  });
}
var F = class {
    constructor(e, n = Number.POSITIVE_INFINITY) {
      this.policy = e;
      this.maxAttempts = n;
      this.attempts = 0;
      this.initialMs = e.initialMs;
    }
    reset(e = this.policy.initialMs) {
      (this.cancel(),
        (this.attempts = 0),
        (this.initialMs = e),
        (this.nextDelayOverrideMs = void 0));
    }
    cancel(e = new Error("retry cancelled")) {
      (this.pendingAbort?.abort(e), (this.pendingAbort = void 0));
    }
    next(e) {
      let n = this.nextDelayOverrideMs;
      if (
        ((this.nextDelayOverrideMs = void 0),
        n === void 0 && ++this.attempts > Math.ceil(this.maxAttempts))
      )
        return;
      let o = Math.max(this.attempts, 1),
        i = n ?? We({ ...this.policy, initialMs: this.initialMs }, o);
      this.cancel();
      let r = new AbortController();
      return (
        (this.pendingAbort = r),
        { attempt: o, delayMs: i, signal: e ? AbortSignal.any([r.signal, e]) : r.signal }
      );
    }
  },
  Q = { attempts: 3, minDelayMs: 300, maxDelayMs: 3e4, jitter: 0 },
  Ke = (t) =>
    new Promise((e) => {
      setTimeout(e, t);
    });
function B(t) {
  return typeof t == "number" && Number.isFinite(t) ? t : void 0;
}
function J(t, e, n, o) {
  let i = B(t);
  return i === void 0
    ? e
    : Math.min(Math.max(i, n ?? Number.NEGATIVE_INFINITY), o ?? Number.POSITIVE_INFINITY);
}
function Ae(t, e) {
  return Math.max(1, Math.round(B(t) ?? e));
}
function G(t) {
  let e = t === Number.POSITIVE_INFINITY ? 2147e6 : (B(t) ?? 0);
  return Math.min(Math.max(Math.round(e), 0), 2147e6);
}
function ze(t, e) {
  if (t === "full") return "full";
  let n = B(t);
  return n === void 0 ? e : Math.min(Math.max(n, 0), 1);
}
function Xe(t = Q, e) {
  let n = Ae(e?.attempts, t.attempts),
    o = G(J(e?.minDelayMs, t.minDelayMs, 0)),
    i = Math.max(o, G(J(e?.maxDelayMs, t.maxDelayMs, 0)));
  return { attempts: n, minDelayMs: o, maxDelayMs: i, jitter: ze(e?.jitter, t.jitter) };
}
function Ze(t, e, n, o) {
  if (e === "full")
    return n === "symmetric"
      ? Math.max(0, Math.round(t * (0.5 + o() * 0.5)))
      : Math.max(0, Math.ceil(t * (1 + o())));
  if (e <= 0) return n === "positive" ? Math.ceil(t) : t;
  let i = o(),
    r = n === "positive" ? i * e : (i * 2 - 1) * e,
    s = t * (1 + r);
  return Math.max(0, n === "positive" ? Math.ceil(s) : Math.round(s));
}
function je(t, e = "Non-Error thrown") {
  if (t instanceof Error) return t;
  if (typeof t == "string") return new Error(t);
  let n = new Error(e, { cause: t });
  return (
    ((typeof t == "object" && t !== null) || typeof t == "function") && Object.assign(n, t), n
  );
}
function $e(t = {}) {
  let e = t.sleep ?? Ke,
    n = t.random ?? Math.random,
    o = t.createFailure ?? ((i) => je(i.at(-1) ?? new Error("Retry failed")));
  return async function (r, s = 3, u = 300) {
    let d = [];
    if (typeof s == "number") {
      let g = Ae(s, Q.attempts);
      for (let E = 0; E < g; E += 1)
        try {
          return await r();
        } catch (D) {
          if ((d.push(D), E === g - 1)) break;
          await e(G(u * 2 ** E));
        }
      throw o(d);
    }
    let a = s,
      l = Xe(Q, a),
      p = l.attempts,
      f = l.minDelayMs,
      y = l.maxDelayMs > 0 ? l.maxDelayMs : Number.POSITIVE_INFINITY,
      T = a.retryAfterMaxDelayMs === void 0 ? y : Math.max(f, G(J(a.retryAfterMaxDelayMs, y, 0))),
      _ = a.random ?? n,
      C = a.sleep ?? e,
      P = a.shouldRetry ?? (() => !0);
    for (let g = 1; g <= p; g += 1)
      try {
        return await r();
      } catch (E) {
        if ((d.push(E), g >= p || !P(E, g))) break;
        let D = { attempt: g, maxAttempts: p, err: E, label: a.label },
          N = a.retryAfterMs?.(E),
          x = typeof N == "number" && Number.isFinite(N),
          U = typeof a.delayMs == "function" ? a.delayMs(D) : a.delayMs,
          ue = U === void 0 ? void 0 : G(U),
          Be = x ? Math.max(N, f) : ue === void 0 ? f * 2 ** (g - 1) : Math.max(ue, f),
          X = x ? T : y,
          v = Math.min(Be, X),
          le = x && (N ?? 0) <= X,
          Ve = (l.jitter === "full" && !x) || le;
        ((v = Ze(v, l.jitter, Ve ? "positive" : "symmetric", _)),
          (v = Math.min(Math.max(v, f), X)),
          await a.onRetry?.({ ...D, delayMs: v }),
          v > 0 && (await C(v)));
      }
    throw o(d);
  };
}
var xt = $e();
var O = class extends Error {
    constructor(e) {
      (super(e.message ?? "request failed"),
        (this.name = "GatewayProtocolRequestError"),
        (this.code = e.code ?? "UNAVAILABLE"),
        (this.gatewayCode = this.code),
        (this.details = e.details),
        (this.retryable = e.retryable === !0),
        (this.retryAfterMs = e.retryAfterMs));
    }
  },
  ee = class {
    constructor(e) {
      this.opts = e;
      this.socket = null;
      this.pending = new Map();
      this.listeners = new Set();
      this.stopped = !0;
      this.generation = 0;
      this.lastSeq = null;
      this.connectNonce = null;
      this.connectSent = !1;
      this.connectRequestSent = !1;
      this.handshakeTimer = null;
      this.socketOpened = !1;
      this.helloReceived = !1;
      this.connectTiming = null;
      this.reconnectSupervisor = new F({
        initialMs: e.reconnect.initialMs,
        maxMs: e.reconnect.maxMs,
        factor: e.reconnect.multiplier,
        jitter: 0,
      });
    }
    get connected() {
      return this.socket?.isOpen() ?? !1;
    }
    get hasPendingRequests() {
      return this.pending.size > 0;
    }
    get connecting() {
      return this.connectSent && !this.helloReceived;
    }
    get hasUnboundedPendingRequests() {
      return [...this.pending.values()].some((e) => e.unbounded);
    }
    start() {
      ((this.stopped = !1), this.reconnectSupervisor.cancel(), this.connect());
    }
    stop() {
      ((this.stopped = !0), this.clearHandshakeTimer(), this.reconnectSupervisor.reset());
      let e = this.socket;
      (e &&
        this.opts.notifyStoppedClose &&
        (this.stoppedSocket = { socket: e, context: this.closeContext() }),
        (this.socket = null),
        (this.connectFailure = void 0),
        (this.connectTiming = null),
        this.flushRequests(new Error("gateway client stopped")),
        e?.close());
    }
    request(e, n, o) {
      let i = this.socket;
      if (!i?.isOpen()) return Promise.reject(new Error("gateway not connected"));
      if (typeof e != "string" || e.length === 0)
        return Promise.reject(
          new Error("invalid request frame: method must be a non-empty string"),
        );
      let r = this.opts.createRequestId(),
        s = o?.timeoutMs === null ? void 0 : (o?.timeoutMs ?? this.opts.requestTimeoutMs);
      return new Promise((u, d) => {
        let a,
          l = {
            resolve: (y) => u(y),
            reject: d,
            expectFinal: o?.expectFinal === !0,
            acceptedNotified: !1,
            onAccepted: o?.onAccepted,
            unbounded: s === void 0,
            method: e,
            startedAtMs: this.nowMs(),
          },
          p = () => {
            (this.pending.delete(r),
              a && clearTimeout(a),
              this.finishRequestTiming(r, l, !1, "CLIENT_ABORTED"),
              d(
                this.opts.createRequestAbortError?.(e) ??
                  new Error(`gateway request aborted for ${e}`),
              ));
          },
          f = () => {
            (a && clearTimeout(a), o?.signal?.removeEventListener("abort", p));
          };
        if (o?.signal?.aborted) {
          d(
            this.opts.createRequestAbortError?.(e) ?? new Error(`gateway request aborted for ${e}`),
          );
          return;
        }
        ((l.cleanup = f),
          s !== void 0 &&
            s >= 0 &&
            ((a = setTimeout(() => {
              (this.pending.delete(r),
                o?.signal?.removeEventListener("abort", p),
                this.finishRequestTiming(r, l, !1, "CLIENT_TIMEOUT"),
                d(
                  this.opts.createRequestTimeoutError?.(e, s) ??
                    new Error(`gateway request timed out after ${s}ms: ${e}`),
                ));
            }, s)),
            a.unref?.()),
          o?.signal?.addEventListener("abort", p, { once: !0 }),
          this.pending.set(r, l));
        try {
          i.send(JSON.stringify({ type: "req", id: r, method: e, params: n }));
        } catch (y) {
          (this.pending.delete(r),
            f(),
            this.finishRequestTiming(r, l, !1, "CLIENT_SEND_ERROR"),
            d(y instanceof Error ? y : new Error(String(y))));
        }
      });
    }
    addEventListener(e) {
      return (this.listeners.add(e), () => this.listeners.delete(e));
    }
    closeSocket(e, n) {
      this.socket?.close(e, n);
    }
    resetReconnectBackoff(e) {
      this.reconnectSupervisor.reset(e);
    }
    recordTiming(e, n, o, i) {
      let r = this.nowMs(),
        s = this.connectTiming;
      !s ||
        s.generation !== n ||
        ((s.hasChallenge ||= e === "challenge"),
        (s.usedFallback ||= e === "fallback"),
        this.invoke("connect timing", () =>
          this.opts.onTiming?.({
            phase: e,
            generation: n,
            durationMs: Math.max(0, r - s.startedAtMs),
            phaseDurationMs: Math.max(0, r - s.lastAtMs),
            hasChallenge: s.hasChallenge,
            usedFallback: s.usedFallback,
            plan: o,
            detail: i,
          }),
        ),
        (s.lastAtMs = r),
        (e === "hello" || e === "failed") && (this.connectTiming = null));
    }
    connect() {
      if (this.stopped) return;
      let e = this.generation + 1;
      ((this.connectNonce = null),
        (this.connectSent = !1),
        (this.connectRequestSent = !1),
        (this.socketOpened = !1),
        (this.helloReceived = !1),
        (this.connectFailure = void 0));
      let n;
      try {
        n = this.opts.createSocket({
          open: () => this.handleOpen(n, e),
          message: (i) => this.handleMessage(n, e, i),
          close: (i, r) => this.handleClose(n, e, i, r),
          error: (i) => this.handleSocketError(n, e, i),
        });
      } catch (i) {
        let r = i instanceof Error ? i : new Error(String(i));
        if (
          (this.opts.onSocketFactoryError?.(r),
          this.opts.onConnectError?.(r),
          this.opts.rethrowSocketFactoryError?.(r))
        )
          throw r;
        return;
      }
      ((this.generation = e), (this.socket = n));
      let o = this.nowMs();
      this.connectTiming = {
        generation: e,
        startedAtMs: o,
        lastAtMs: o,
        hasChallenge: !1,
        usedFallback: !1,
      };
    }
    handleOpen(e, n) {
      if (this.isActive(e, n)) {
        if (((this.socketOpened = !0), this.recordTiming("socket-open", n), this.connectNonce)) {
          this.sendConnect(e, n);
          return;
        }
        this.armHandshakeTimer(e, n);
      }
    }
    armHandshakeTimer(e, n) {
      this.clearHandshakeTimer();
      let o = Date.now();
      ((this.handshakeTimer = setTimeout(() => {
        if (((this.handshakeTimer = null), !this.isActive(e, n) || this.connectSent || !e.isOpen()))
          return;
        if (this.opts.handshake.mode === "fallback") {
          (this.recordTiming("fallback", n), this.sendConnect(e, n));
          return;
        }
        let i = Date.now() - o,
          r = new Error(
            this.opts.handshake.timeoutMessage?.(i) ??
              `gateway connect challenge timeout after ${i}ms`,
          );
        (this.opts.onConnectError?.(r), e.close(1008, "connect challenge timeout"));
      }, this.opts.handshake.timeoutMs)),
        this.handshakeTimer.unref?.());
    }
    sendConnect(e, n) {
      if (!this.isActive(e, n) || !e.isOpen() || this.connectSent) return;
      ((this.connectSent = !0), this.clearHandshakeTimer());
      let o;
      try {
        o = this.opts.buildConnectPlan({ nonce: this.connectNonce, generation: n });
      } catch (i) {
        this.handleConnectPlanError(e, n, i);
        return;
      }
      if (o instanceof Promise) {
        o.then((i) => this.sendConnectPlan(e, n, i)).catch((i) =>
          this.handleConnectPlanError(e, n, i),
        );
        return;
      }
      this.sendConnectPlan(e, n, o);
    }
    handleConnectPlanError(e, n, o) {
      if (!this.isActive(e, n)) return;
      let i = o instanceof Error ? o : new Error(String(o)),
        r = this.opts.onConnectPlanError?.(i) ?? { closeCode: 1008, closeReason: "connect failed" };
      (this.opts.onConnectError?.(r.error ?? i),
        r.stop && (this.stopped = !0),
        e.close(r.closeCode, r.closeReason));
    }
    sendConnectPlan(e, n, o) {
      if (!this.isActive(e, n) || !e.isOpen()) return;
      let i = { generation: n, nonce: this.connectNonce, plan: o };
      (this.recordTiming("connect-plan-ready", n, o),
        this.recordTiming("request-sent", n, o),
        (this.connectRequestSent = !0),
        this.request("connect", this.opts.buildConnectParams(o))
          .then((r) => {
            this.isActive(e, n) &&
              ((this.helloReceived = !0),
              (this.connectFailure = void 0),
              this.reconnectSupervisor.reset(),
              this.recordTiming("hello", n, o),
              this.opts.onConnectHello?.(r, i),
              this.invoke("hello", () => this.opts.onHello?.(r)));
          })
          .catch((r) => {
            if (!this.isActive(e, n)) return;
            let s = r instanceof O ? r : new O({ message: String(r) }),
              u = this.opts.onConnectFailure?.(s, i) ?? {
                closeCode: 1008,
                closeReason: "connect failed",
              };
            ((this.connectFailure = { error: s, reconnectDelayMs: u.reconnectDelayMs }),
              u.stop && (this.stopped = !0),
              e.close(u.closeCode, u.closeReason));
          }));
    }
    handleMessage(e, n, o) {
      if (!this.isActive(e, n)) return;
      let i;
      try {
        i = JSON.parse(o);
      } catch (r) {
        this.opts.onParseError?.(r);
        return;
      }
      if (Te(i)) {
        if ((this.opts.onActivity?.(), i.event === "connect.challenge")) {
          let s = i.payload,
            u = typeof s?.nonce == "string" ? s.nonce.trim() : "";
          if (!u) {
            if (this.opts.handshake.mode === "require-challenge") {
              let d = new Error("gateway connect challenge missing nonce");
              (this.opts.onConnectError?.(d), e.close(1008, "connect challenge missing nonce"));
            }
            return;
          }
          ((this.connectNonce = u), this.recordTiming("challenge", n), this.sendConnect(e, n));
          return;
        }
        let r = typeof i.seq == "number" ? i.seq : null;
        if (r !== null) {
          if (this.lastSeq !== null && r > this.lastSeq + 1) {
            let s = this.lastSeq + 1;
            this.invoke("gap", () => this.opts.onGap?.({ expected: s, received: r }));
          }
          this.lastSeq = r;
        }
        this.invoke("event", () => this.opts.onEvent?.(i));
        for (let s of this.listeners) this.invoke("event listener", () => s(i));
        return;
      }
      ge(i) && (this.opts.onActivity?.(), this.handleResponse(i));
    }
    handleResponse(e) {
      let n = this.pending.get(e.id);
      if (!n) return;
      let o = e.payload?.status;
      if (n.expectFinal && o === "accepted") {
        n.acceptedNotified ||
          ((n.acceptedNotified = !0), this.invoke("accepted", () => n.onAccepted?.(e.payload)));
        return;
      }
      if ((this.pending.delete(e.id), n.cleanup?.(), e.ok)) {
        (this.finishRequestTiming(e.id, n, !0), n.resolve(e.payload));
        return;
      }
      (this.finishRequestTiming(e.id, n, !1, e.error?.code),
        n.reject(this.opts.createRequestError?.(e.error ?? {}) ?? new O(e.error ?? {})));
    }
    handleClose(e, n, o, i) {
      if (this.socket !== e) {
        if (this.stoppedSocket?.socket === e) {
          let u = { ...this.stoppedSocket.context, code: o, reason: i };
          ((this.stoppedSocket = void 0),
            this.invoke("close", () => this.opts.onClose?.(u, { retry: !1, notify: !0 })));
        }
        return;
      }
      ((this.socket = null), this.clearHandshakeTimer());
      let r = { ...this.closeContext(), code: o, reason: i, generation: n };
      this.connectFailure = void 0;
      let s = this.opts.resolveClose(r);
      (this.flushRequests(
        s.pendingError ?? r.connectFailure?.error ?? new Error(`gateway closed (${o}): ${i}`),
      ),
        this.invoke("close", () => this.opts.onClose?.(r, s)),
        s.retry &&
          !this.stopped &&
          this.scheduleReconnect(s.reconnectDelayMs ?? r.connectFailure?.reconnectDelayMs));
    }
    handleSocketError(e, n, o) {
      !this.isActive(e, n) || this.connectSent || this.opts.onConnectError?.(o);
    }
    flushRequests(e) {
      for (let [n, o] of this.pending)
        (this.finishRequestTiming(n, o, !1, "CLIENT_CLOSED"), o.cleanup?.(), o.reject(e));
      this.pending.clear();
    }
    finishRequestTiming(e, n, o, i) {
      let r = this.nowMs();
      this.invoke("request timing", () =>
        this.opts.onRequestTiming?.({
          id: e,
          method: n.method,
          ok: o,
          durationMs: Math.max(0, r - n.startedAtMs),
          startedAtMs: n.startedAtMs,
          endedAtMs: r,
          errorCode: i,
        }),
      );
    }
    scheduleReconnect(e) {
      e !== void 0 && (this.reconnectSupervisor.nextDelayOverrideMs = e);
      let n = this.reconnectSupervisor.next();
      n &&
        Ee(n.delayMs, n.signal).then(
          () => this.connect(),
          () => {},
        );
    }
    closeContext() {
      return {
        generation: this.generation,
        socketOpened: this.socketOpened,
        helloReceived: this.helloReceived,
        connectRequestSent: this.connectRequestSent,
        connectFailure: this.connectFailure,
      };
    }
    isActive(e, n) {
      return !this.stopped && this.socket === e && this.generation === n;
    }
    nowMs() {
      return this.opts.nowMs?.() ?? Date.now();
    }
    clearHandshakeTimer() {
      this.handshakeTimer && (clearTimeout(this.handshakeTimer), (this.handshakeTimer = null));
    }
    invoke(e, n) {
      try {
        n();
      } catch (o) {
        this.opts.onCallbackError?.(e, o);
      }
    }
  };
var Ie = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  BROWSER_COPILOT: "openclaw-browser-copilot",
  TUI: "openclaw-tui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  WATCHOS_APP: "openclaw-watchos",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  WORKER: "openclaw-worker",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
};
var Re = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    WORKER: "worker",
    PROBE: "probe",
    TEST: "test",
  },
  Qe = {
    APPROVALS: "approvals",
    EXEC_APPROVALS: "exec-approvals",
    INLINE_WIDGETS: "inline-widgets",
    RUN_TOOL_BINDINGS: "run-tool-bindings",
    SESSION_SCOPED_EVENTS: "session-scoped-events",
    PLUGIN_APPROVALS: "plugin-approvals",
    TASK_SUGGESTIONS: "task-suggestions",
    TERMINAL_OFFSET_SEQ: "terminal-offset-seq",
    TOOL_EVENTS: "tool-events",
    UI_COMMANDS: "ui-commands",
  },
  Ut = new Set(Object.values(Ie)),
  Lt = new Set(Object.values(Re));
var Je = 4,
  et = 4;
/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */ var Me = Object.freeze({
    p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
    n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
    h: 8n,
    a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
    d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
    Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
    Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n,
  }),
  { p: Y, n: V, Gx: _e, Gy: Ce, a: te, d: ne, h: tt } = Me,
  q = 32,
  nt = (...t) => {
    "captureStackTrace" in Error &&
      typeof Error.captureStackTrace == "function" &&
      Error.captureStackTrace(...t);
  },
  m = (t = "") => {
    let e = new Error(t);
    throw (nt(e, m), e);
  },
  ot = (t) => typeof t == "bigint",
  rt = (t) => typeof t == "string",
  it = (t) =>
    t instanceof Uint8Array ||
    (ArrayBuffer.isView(t) &&
      t.constructor.name === "Uint8Array" &&
      "BYTES_PER_ELEMENT" in t &&
      t.BYTES_PER_ELEMENT === 1),
  I = (t, e, n = "") => {
    let o = it(t),
      i = t?.length,
      r = e !== void 0;
    if (!o || (r && i !== e)) {
      let s = n && `"${n}" `,
        u = r ? ` of length ${e}` : "",
        d = o ? `length=${i}` : `type=${typeof t}`,
        a = s + "expected Uint8Array" + u + ", got " + d;
      throw o ? new RangeError(a) : new TypeError(a);
    }
    return t;
  },
  z = (t) => new Uint8Array(t),
  ce = (t) => Uint8Array.from(t),
  Pe = (t, e) => t.toString(16).padStart(e, "0"),
  De = (t) =>
    Array.from(I(t))
      .map((e) => Pe(e, 2))
      .join(""),
  R = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 },
  ve = (t) => {
    if (t >= R._0 && t <= R._9) return t - R._0;
    if (t >= R.A && t <= R.F) return t - (R.A - 10);
    if (t >= R.a && t <= R.f) return t - (R.a - 10);
  },
  Ne = (t) => {
    let e = "hex invalid";
    if (!rt(t)) return m(e);
    let n = t.length,
      o = n / 2;
    if (n % 2) return m(e);
    let i = z(o);
    for (let r = 0, s = 0; r < o; r++, s += 2) {
      let u = ve(t.charCodeAt(s)),
        d = ve(t.charCodeAt(s + 1));
      if (u === void 0 || d === void 0) return m(e);
      i[r] = u * 16 + d;
    }
    return i;
  },
  xe = () => globalThis?.crypto,
  st = () => xe()?.subtle ?? m("crypto.subtle must be defined, consider polyfill"),
  H = (...t) => {
    let e = 0;
    for (let i of t) e += I(i).length;
    let n = z(e),
      o = 0;
    return (
      t.forEach((i) => {
        (n.set(i, o), (o += i.length));
      }),
      n
    );
  },
  ct = (t = q) => xe().getRandomValues(z(t)),
  W = BigInt,
  S = (t, e, n, o = "bad number: out of range") => {
    if (!ot(t)) throw new TypeError(o);
    if (e <= t && t < n) return t;
    throw new RangeError(o);
  },
  h = (t, e = Y) => {
    let n = t % e;
    return n >= 0n ? n : e + n;
  },
  be = (1n << 255n) - 1n,
  c = (t) => {
    t < 0n && m("negative coordinate");
    let e = (t >> 255n) * 19n + (t & be);
    return ((e = (e >> 255n) * 19n + (e & be)), e % Y);
  },
  Oe = (t) => h(t, V),
  at = (t, e) => {
    (t === 0n || e <= 0n) && m("no inverse n=" + t + " mod=" + e);
    let n = h(t, e),
      o = e,
      i = 0n,
      r = 1n,
      s = 1n,
      u = 0n;
    for (; n !== 0n;) {
      let d = o / n,
        a = o % n,
        l = i - s * d,
        p = r - u * d;
      ((o = n), (n = a), (i = s), (r = u), (s = l), (u = p));
    }
    return o === 1n ? h(i, e) : m("no inverse");
  },
  qe = (t) => {
    let e = Tt[t];
    return (typeof e != "function" && m("hashes." + t + " not set"), e);
  },
  Ge = (t) => I(t, 64, "digest");
var oe = (t) => (t instanceof k ? t : m("Point expected")),
  re = 2n ** 256n,
  k = class t {
    static BASE;
    static ZERO;
    X;
    Y;
    Z;
    T;
    constructor(e, n, o, i) {
      let r = re;
      ((this.X = S(e, 0n, r)),
        (this.Y = S(n, 0n, r)),
        (this.Z = S(o, 1n, r)),
        (this.T = S(i, 0n, r)),
        Object.freeze(this));
    }
    static CURVE() {
      return Me;
    }
    static fromAffine(e) {
      return new t(e.x, e.y, 1n, c(e.x * e.y));
    }
    static fromBytes(e, n = !1) {
      let o = ne,
        i = ce(I(e, q)),
        r = e[31];
      i[31] = r & -129;
      let s = Ue(i);
      S(s, 0n, n ? re : Y);
      let d = c(s * s),
        a = h(d - 1n),
        l = c(o * d + 1n),
        { isValid: p, value: f } = ut(a, l);
      p || m("bad point: y not sqrt");
      let y = (f & 1n) === 1n,
        T = (r & 128) !== 0;
      return (
        !n && f === 0n && T && m("bad point: x==0, isLastByteOdd"),
        T !== y && (f = h(-f)),
        new t(f, s, 1n, c(f * s))
      );
    }
    static fromHex(e, n) {
      return t.fromBytes(Ne(e), n);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    assertValidity() {
      let e = te,
        n = ne,
        o = this;
      if (o.is0()) return m("bad point: ZERO");
      let { X: i, Y: r, Z: s, T: u } = o,
        d = c(i * i),
        a = c(r * r),
        l = c(s * s),
        p = c(l * l),
        f = c(d * e),
        y = c(l * (f + a)),
        T = h(p + c(n * c(d * a)));
      if (y !== T) return m("bad point: equation left != right (1)");
      let _ = c(i * r),
        C = c(s * u);
      return _ !== C ? m("bad point: equation left != right (2)") : this;
    }
    equals(e) {
      let { X: n, Y: o, Z: i } = this,
        { X: r, Y: s, Z: u } = oe(e),
        d = c(n * u),
        a = c(r * i),
        l = c(o * u),
        p = c(s * i);
      return d === a && l === p;
    }
    is0() {
      return this.equals(w);
    }
    negate() {
      return new t(h(-this.X), this.Y, this.Z, h(-this.T));
    }
    double() {
      let { X: e, Y: n, Z: o } = this,
        i = te,
        r = c(e * e),
        s = c(n * n),
        u = c(2n * o * o),
        d = c(i * r),
        a = h(e + n),
        l = h(c(a * a) - r - s),
        p = h(d + s),
        f = h(p - u),
        y = h(d - s),
        T = c(l * f),
        _ = c(p * y),
        C = c(l * y),
        P = c(f * p);
      return new t(T, _, P, C);
    }
    add(e) {
      let { X: n, Y: o, Z: i, T: r } = this,
        { X: s, Y: u, Z: d, T: a } = oe(e),
        l = te,
        p = ne,
        f = c(n * s),
        y = c(o * u),
        T = c(c(r * p) * a),
        _ = c(i * d),
        C = h(c(h(n + o) * h(s + u)) - f - y),
        P = h(_ - T),
        g = h(_ + T),
        E = h(y - c(l * f)),
        D = c(C * P),
        N = c(g * E),
        x = c(C * E),
        U = c(P * g);
      return new t(D, N, U, x);
    }
    subtract(e) {
      return this.add(oe(e).negate());
    }
    multiply(e, n = !0) {
      if ((!n && e === 0n) || (S(e, 1n, V), !n && this.is0())) return w;
      if (e === 1n) return this;
      if (this.equals(M)) return Rt(e).p;
      let o = w,
        i = M;
      for (let r = this; e > 0n; r = r.double(), e >>= 1n)
        e & 1n ? (o = o.add(r)) : n && (i = i.add(r));
      return o;
    }
    multiplyUnsafe(e) {
      return this.multiply(e, !1);
    }
    toAffine() {
      let { X: e, Y: n, Z: o } = this;
      if (this.equals(w)) return { x: 0n, y: 1n };
      let i = at(o, Y);
      c(o * i) !== 1n && m("invalid inverse");
      let r = c(e * i),
        s = c(n * i);
      return { x: r, y: s };
    }
    toBytes() {
      let { x: e, y: n } = this.toAffine(),
        o = He(n);
      return ((o[31] |= e & 1n ? 128 : 0), o);
    }
    toHex() {
      return De(this.toBytes());
    }
    clearCofactor() {
      return this.multiply(W(tt), !1);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      let e = this.multiply(V / 2n, !1).double();
      return (V % 2n && (e = e.add(this)), e.is0());
    }
  },
  M = new k(_e, Ce, 1n, h(_e * Ce)),
  w = new k(0n, 1n, 1n, 0n);
k.BASE = M;
k.ZERO = w;
var He = (t) => Ne(Pe(S(t, 0n, re), 64)).reverse(),
  Ue = (t) => W("0x" + De(ce(I(t)).reverse())),
  A = (t, e) => {
    let n = t;
    for (; e-- > 0n;) n = c(n * n);
    return n;
  },
  dt = (t) => {
    let e = c(t * t),
      n = c(e * t),
      o = c(A(n, 2n) * n),
      i = c(A(o, 1n) * t),
      r = c(A(i, 5n) * i),
      s = c(A(r, 10n) * r),
      u = c(A(s, 20n) * s),
      d = c(A(u, 40n) * u),
      a = c(A(d, 80n) * d),
      l = c(A(a, 80n) * d),
      p = c(A(l, 10n) * r);
    return { pow_p_5_8: c(A(p, 2n) * t), b2: n };
  },
  Se = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n,
  ut = (t, e) => {
    let n = c(e * c(e * e)),
      o = c(c(n * n) * e),
      i = dt(c(t * o)).pow_p_5_8,
      r = c(t * c(n * i)),
      s = c(e * c(r * r)),
      u = r,
      d = c(r * Se),
      a = s === t,
      l = s === h(-t),
      p = s === h(-t * Se);
    return (
      a && (r = u),
      (l || p) && (r = d),
      (h(r) & 1n) === 1n && (r = h(-r)),
      { isValid: a || l, value: r }
    );
  },
  ie = (t) => Oe(Ue(t)),
  ae = (...t) => Promise.resolve(qe("sha512Async")(H(...t))).then(Ge),
  lt = (...t) => Ge(qe("sha512")(H(...t))),
  Le = (t) => {
    let e = ce(t),
      n = e.slice(0, 32);
    ((n[0] &= 248), (n[31] &= 127), (n[31] |= 64));
    let o = e.slice(32, 64),
      i = ie(n),
      r = M.multiply(i),
      s = r.toBytes();
    return { head: n, prefix: o, scalar: i, point: r, pointBytes: s };
  },
  de = (t) => ae(I(t, q)).then(Le),
  pt = (t) => Le(lt(I(t, q))),
  ft = (t) => de(t).then((e) => e.pointBytes);
var ht = (t) => ae(t.hashable).then(t.finish);
var yt = (t, e, n) => {
    let { pointBytes: o, scalar: i } = t,
      r = ie(e),
      s = M.multiply(r).toBytes();
    return {
      hashable: H(s, o, n),
      finish: (a) => {
        let l = Oe(r + ie(a) * i);
        return I(H(s, He(l)), 64);
      },
    };
  },
  mt = async (t, e) => {
    let n = I(t),
      o = await de(e),
      i = await ae(o.prefix, n);
    return ht(yt(o, i, n));
  };
var Tt = {
    sha512Async: async (t) => {
      let e = st(),
        n = H(t);
      return z(await e.digest("SHA-512", n.buffer));
    },
    sha512: void 0,
  },
  gt = (t) => ((t = t === void 0 ? ct(q) : t), I(t, q));
var Et = Object.freeze({
    getExtendedPublicKeyAsync: de,
    getExtendedPublicKey: pt,
    randomSecretKey: gt,
  }),
  K = 8,
  At = 256,
  Fe = Math.ceil(At / K) + 1,
  se = 2 ** (K - 1),
  It = () => {
    let t = [],
      e = M,
      n = e;
    for (let o = 0; o < Fe; o++) {
      ((n = e), t.push(n));
      for (let i = 1; i < se; i++) ((n = n.add(e)), t.push(n));
      e = n.double();
    }
    return t;
  },
  we,
  ke = (t, e) => {
    let n = e.negate();
    return t ? n : e;
  },
  Rt = (t) => {
    let e = we || (we = It()),
      n = w,
      o = M,
      i = 2 ** K,
      r = i,
      s = W(i - 1),
      u = W(K);
    for (let d = 0; d < Fe; d++) {
      let a = Number(t & s);
      ((t >>= u), a > se && ((a -= r), (t += 1n)));
      let l = d * se,
        p = l,
        f = l + Math.abs(a) - 1,
        y = d % 2 !== 0,
        T = a < 0;
      a === 0 ? (o = o.add(ke(y, e[p]))) : (n = n.add(ke(T, e[f])));
    }
    return (t !== 0n && m("invalid wnaf"), { p: n, f: o });
  };
export {
  Qe as GATEWAY_CLIENT_CAPS,
  Ie as GATEWAY_CLIENT_IDS,
  Re as GATEWAY_CLIENT_MODES,
  j as GatewayBrowserDeviceAuthLifecycle,
  ee as GatewayProtocolClient,
  O as GatewayProtocolRequestError,
  et as MIN_CLIENT_PROTOCOL_VERSION,
  Je as PROTOCOL_VERSION,
  Et as ed25519Utils,
  ft as getPublicKeyAsync,
  mt as signAsync,
};
