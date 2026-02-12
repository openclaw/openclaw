"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [50528],
  {
    50528: (t, e, i) => {
      (i.r(e), i.d(e, { Controlled: () => E, default: () => b }));
      var n = i(7620),
        o = i(97509);
      let a = (t, e) => t === e?.tagName?.toUpperCase?.(),
        s = (t) => a("DIV", t) || a("SPAN", t),
        r = (t) => a("IMG", t),
        h = (t) => t.complete && 0 !== t.naturalHeight,
        l = (t) => a("SVG", t),
        d = ({ height: t, offset: e, width: i }) =>
          Math.min((window.innerWidth - 2 * e) / i, (window.innerHeight - 2 * e) / t),
        c = ({
          containerHeight: t,
          containerWidth: e,
          hasScalableSrc: i,
          offset: n,
          targetHeight: o,
          targetWidth: a,
        }) =>
          t && e
            ? !i && o && a
              ? (({
                  containerHeight: t,
                  containerWidth: e,
                  offset: i,
                  targetHeight: n,
                  targetWidth: o,
                }) => {
                  let a = d({ height: n, offset: i, width: o }),
                    s = o > n ? o / e : n / t;
                  return a > 1 ? s : a * s;
                })({
                  containerHeight: t,
                  containerWidth: e,
                  offset: n,
                  targetHeight: o,
                  targetWidth: a,
                })
              : d({ height: t, offset: n, width: e })
            : 1,
        m = /url(?:\(['"]?)(.*?)(?:['"]?\))/,
        g = (t) => {
          if (t) {
            if (r(t)) {
              return t.currentSrc;
            } else if (s(t)) {
              let e = window.getComputedStyle(t).backgroundImage;
              if (e) {
                return m.exec(e)?.[1];
              }
            }
          }
        },
        u = ({ position: t, relativeNum: e }) => {
          let i = parseFloat(t);
          return t.endsWith("%") ? (e * i) / 100 : i;
        },
        v = /\.svg$/i,
        p = (t) => {
          if (!t) {
            return {};
          }
          if (!l(t)) {
            return {
              height: t.offsetHeight,
              left: t.offsetLeft,
              width: t.offsetWidth,
              top: t.offsetTop,
            };
          }
          {
            let e = t.parentElement,
              i = t.getBoundingClientRect();
            if (!e) {
              return { height: i.height, left: i.left, width: i.width, top: i.top };
            }
            {
              let t = e.getBoundingClientRect();
              return {
                height: i.height,
                left: t.left - i.left,
                top: t.top - i.top,
                width: i.width,
              };
            }
          }
        },
        w = ["img", "svg", '[role="img"]', "[data-zoom]"]
          .map((t) => `${t}:not([aria-hidden="true"])`)
          .join(","),
        f = { overflow: "", width: "" };
      function E(t) {
        return n.createElement(L, { ...t });
      }
      class L extends n.Component {
        constructor() {
          (super(...arguments),
            (this.state = {
              id: "",
              isZoomImgLoaded: !1,
              loadedImgEl: void 0,
              modalState: "UNLOADED",
              shouldRefresh: !1,
              styleGhost: {},
            }),
            (this.refContent = n.createRef()),
            (this.refDialog = n.createRef()),
            (this.refModalContent = n.createRef()),
            (this.refModalImg = n.createRef()),
            (this.refWrap = n.createRef()),
            (this.imgEl = null),
            (this.isScaling = !1),
            (this.prevBodyAttrs = f),
            (this.styleModalImg = {}),
            (this.handleModalStateChange = (t) => {
              let { modalState: e } = this.state;
              "LOADING" !== t && "LOADING" === e
                ? (this.loadZoomImg(),
                  window.addEventListener("resize", this.handleResize, { passive: !0 }),
                  window.addEventListener("touchstart", this.handleTouchStart, { passive: !0 }),
                  window.addEventListener("touchmove", this.handleTouchMove, { passive: !0 }),
                  window.addEventListener("touchend", this.handleTouchEnd, { passive: !0 }),
                  window.addEventListener("touchcancel", this.handleTouchCancel, { passive: !0 }),
                  document.addEventListener("keydown", this.handleKeyDown, !0))
                : "LOADED" !== t && "LOADED" === e
                  ? window.addEventListener("wheel", this.handleWheel, { passive: !0 })
                  : "UNLOADING" !== t && "UNLOADING" === e
                    ? (this.ensureImgTransitionEnd(),
                      window.removeEventListener("wheel", this.handleWheel),
                      window.removeEventListener("touchstart", this.handleTouchStart),
                      window.removeEventListener("touchmove", this.handleTouchMove),
                      window.removeEventListener("touchend", this.handleTouchEnd),
                      window.removeEventListener("touchcancel", this.handleTouchCancel),
                      document.removeEventListener("keydown", this.handleKeyDown, !0))
                    : "UNLOADED" !== t &&
                      "UNLOADED" === e &&
                      (this.bodyScrollEnable(),
                      window.removeEventListener("resize", this.handleResize),
                      this.refModalImg.current?.removeEventListener?.(
                        "transitionend",
                        this.handleImgTransitionEnd,
                      ),
                      this.refDialog.current?.close?.());
            }),
            (this.getDialogContainer = () => {
              let t = document.querySelector("[data-rmiz-portal]");
              return (
                null == t &&
                  ((t = document.createElement("div")).setAttribute("data-rmiz-portal", ""),
                  document.body.appendChild(t)),
                t
              );
            }),
            (this.setId = () => {
              let t = () => Math.random().toString(16).slice(-4);
              this.setState({ id: t() + t() + t() });
            }),
            (this.setAndTrackImg = () => {
              let t = this.refContent.current;
              t &&
                ((this.imgEl = t.querySelector(w)),
                this.imgEl
                  ? (this.contentNotFoundChangeObserver?.disconnect?.(),
                    this.imgEl.addEventListener("load", this.handleImgLoad),
                    this.imgEl.addEventListener("click", this.handleZoom),
                    this.state.loadedImgEl || this.handleImgLoad(),
                    (this.imgElResizeObserver = new ResizeObserver((t) => {
                      let e = t[0];
                      e?.target &&
                        ((this.imgEl = e.target), this.setState({ styleGhost: p(this.imgEl) }));
                    })),
                    this.imgElResizeObserver.observe(this.imgEl),
                    this.contentChangeObserver ||
                      ((this.contentChangeObserver = new MutationObserver(() => {
                        this.setState({ styleGhost: p(this.imgEl) });
                      })),
                      this.contentChangeObserver.observe(t, {
                        attributes: !0,
                        childList: !0,
                        subtree: !0,
                      })))
                  : this.contentNotFoundChangeObserver ||
                    ((this.contentNotFoundChangeObserver = new MutationObserver(
                      this.setAndTrackImg,
                    )),
                    this.contentNotFoundChangeObserver.observe(t, { childList: !0, subtree: !0 })));
            }),
            (this.handleIfZoomChanged = (t) => {
              let { isZoomed: e } = this.props;
              !t && e ? this.zoom() : t && !e && this.unzoom();
            }),
            (this.handleImgLoad = () => {
              let t = g(this.imgEl);
              if (!t) {
                return;
              }
              let e = new Image();
              (r(this.imgEl) &&
                ((e.sizes = this.imgEl.sizes),
                (e.srcset = this.imgEl.srcset),
                (e.crossOrigin = this.imgEl.crossOrigin)),
                (e.src = t));
              let i = () => {
                this.setState({ loadedImgEl: e, styleGhost: p(this.imgEl) });
              };
              e.decode()
                .then(i)
                .catch(() => {
                  if (h(e)) {
                    return i();
                  }
                  e.onload = i;
                });
            }),
            (this.handleZoom = () => {
              this.hasImage() && this.props.onZoomChange?.(!0);
            }),
            (this.handleUnzoom = () => {
              this.props.onZoomChange?.(!1);
            }),
            (this.handleBtnUnzoomClick = (t) => {
              (t.preventDefault(), t.stopPropagation(), this.handleUnzoom());
            }),
            (this.handleDialogCancel = (t) => {
              t.preventDefault();
            }),
            (this.handleDialogClick = (t) => {
              (t.target === this.refModalContent.current ||
                t.target === this.refModalImg.current) &&
                (t.stopPropagation(), this.handleUnzoom());
            }),
            (this.handleDialogClose = (t) => {
              (t.stopPropagation(), this.handleUnzoom());
            }),
            (this.handleKeyDown = (t) => {
              ("Escape" === t.key || 27 === t.keyCode) &&
                (t.preventDefault(), t.stopPropagation(), this.handleUnzoom());
            }),
            (this.handleWheel = (t) => {
              t.ctrlKey ||
                (t.stopPropagation(),
                queueMicrotask(() => {
                  this.handleUnzoom();
                }));
            }),
            (this.handleTouchStart = (t) => {
              if (t.touches.length > 1) {
                this.isScaling = !0;
                return;
              }
              1 === t.changedTouches.length &&
                t.changedTouches[0] &&
                (this.touchYStart = t.changedTouches[0].screenY);
            }),
            (this.handleTouchMove = (t) => {
              let e = window.visualViewport?.scale ?? 1;
              this.props.canSwipeToUnzoom &&
                !this.isScaling &&
                e <= 1 &&
                null != this.touchYStart &&
                t.changedTouches[0] &&
                ((this.touchYEnd = t.changedTouches[0].screenY),
                Math.abs(
                  Math.max(this.touchYStart, this.touchYEnd) -
                    Math.min(this.touchYStart, this.touchYEnd),
                ) > this.props.swipeToUnzoomThreshold &&
                  ((this.touchYStart = void 0), (this.touchYEnd = void 0), this.handleUnzoom()));
            }),
            (this.handleTouchEnd = () => {
              ((this.isScaling = !1), (this.touchYStart = void 0), (this.touchYEnd = void 0));
            }),
            (this.handleTouchCancel = () => {
              ((this.isScaling = !1), (this.touchYStart = void 0), (this.touchYEnd = void 0));
            }),
            (this.handleResize = () => {
              this.setState({ shouldRefresh: !0 });
            }),
            (this.hasImage = () =>
              this.imgEl &&
              (this.state.loadedImgEl || l(this.imgEl)) &&
              "none" !== window.getComputedStyle(this.imgEl).display),
            (this.zoom = () => {
              (this.bodyScrollDisable(),
                this.refDialog.current?.showModal?.(),
                this.refModalImg.current?.addEventListener?.(
                  "transitionend",
                  this.handleImgTransitionEnd,
                ),
                this.setState({ modalState: "LOADING" }));
            }),
            (this.unzoom = () => {
              this.setState({ modalState: "UNLOADING" });
            }),
            (this.handleImgTransitionEnd = () => {
              (clearTimeout(this.timeoutTransitionEnd),
                "LOADING" === this.state.modalState
                  ? this.setState({ modalState: "LOADED" })
                  : "UNLOADING" === this.state.modalState &&
                    this.setState({ shouldRefresh: !1, modalState: "UNLOADED" }));
            }),
            (this.ensureImgTransitionEnd = () => {
              if (this.refModalImg.current) {
                let t = window.getComputedStyle(this.refModalImg.current).transitionDuration,
                  e = parseFloat(t);
                if (e) {
                  let i = e * (t.endsWith("ms") ? 1 : 1e3) + 50;
                  this.timeoutTransitionEnd = setTimeout(this.handleImgTransitionEnd, i);
                }
              }
            }),
            (this.bodyScrollDisable = () => {
              this.prevBodyAttrs = {
                overflow: document.body.style.overflow,
                width: document.body.style.width,
              };
              let t = document.body.clientWidth;
              ((document.body.style.overflow = "hidden"), (document.body.style.width = `${t}px`));
            }),
            (this.bodyScrollEnable = () => {
              ((document.body.style.width = this.prevBodyAttrs.width),
                (document.body.style.overflow = this.prevBodyAttrs.overflow),
                (this.prevBodyAttrs = f));
            }),
            (this.loadZoomImg = () => {
              let {
                  props: { zoomImg: t },
                } = this,
                e = t?.src;
              if (e) {
                let i = new Image();
                ((i.sizes = t?.sizes ?? ""),
                  (i.srcset = t?.srcSet ?? ""),
                  (i.crossOrigin = t?.crossOrigin ?? void 0),
                  (i.src = e));
                let n = () => {
                  this.setState({ isZoomImgLoaded: !0 });
                };
                i.decode()
                  .then(n)
                  .catch(() => {
                    if (h(i)) {
                      return n();
                    }
                    i.onload = n;
                  });
              }
            }),
            (this.UNSAFE_handleSvg = () => {
              let { imgEl: t, refModalImg: e, styleModalImg: i } = this;
              if (l(t)) {
                let n = t.cloneNode(!0);
                (((t) => {
                  let e = "-zoom",
                    i = ["clip-path", "fill", "mask", "marker-start", "marker-mid", "marker-end"],
                    n = new Map();
                  if (t.hasAttribute("id")) {
                    let i = t.id,
                      o = i + e;
                    (n.set(i, o), (t.id = o));
                  }
                  (t.querySelectorAll("[id]").forEach((t) => {
                    let i = t.id,
                      o = i + e;
                    (n.set(i, o), (t.id = o));
                  }),
                    n.forEach((e, n) => {
                      let o = `url(#${n})`,
                        a = `url(#${e})`,
                        s = i.map((t) => `[${t}="${o}"]`).join(", ");
                      t.querySelectorAll(s).forEach((t) => {
                        i.forEach((e) => {
                          t.getAttribute(e) === o && t.setAttribute(e, a);
                        });
                      });
                    }),
                    t.querySelectorAll("style").forEach((t) => {
                      n.forEach((e, i) => {
                        t.textContent &&
                          (t.textContent = t.textContent.replaceAll(`#${i}`, `#${e}`));
                      });
                    }));
                })(n),
                  (n.style.width = `${i.width || 0}px`),
                  (n.style.height = `${i.height || 0}px`),
                  n.addEventListener("click", this.handleUnzoom),
                  e.current?.firstChild?.remove?.(),
                  e.current?.appendChild?.(n));
              }
            }));
        }
        render() {
          let {
              handleBtnUnzoomClick: t,
              handleDialogCancel: e,
              handleDialogClick: i,
              handleDialogClose: a,
              handleUnzoom: h,
              handleZoom: d,
              imgEl: m,
              props: {
                a11yNameButtonUnzoom: p,
                a11yNameButtonZoom: w,
                children: f,
                classDialog: E,
                IconUnzoom: L,
                IconZoom: b,
                isZoomed: S,
                wrapElement: y,
                ZoomContent: z,
                zoomImg: I,
                zoomMargin: C,
              },
              refContent: D,
              refDialog: N,
              refModalContent: T,
              refModalImg: M,
              refWrap: O,
              state: {
                id: A,
                isZoomImgLoaded: U,
                loadedImgEl: k,
                modalState: W,
                shouldRefresh: $,
                styleGhost: x,
              },
            } = this,
            Z = `rmiz-modal-${A}`,
            H = `rmiz-modal-img-${A}`,
            R = s(m),
            F = r(m),
            G = l(m),
            Y = ((t) => {
              if (t) {
                if (r(t)) return t.alt ?? void 0;
                else return t.getAttribute("aria-label") ?? void 0;
              }
            })(m),
            B = g(m),
            P = F ? m.sizes : void 0,
            j = F ? m.srcset : void 0,
            _ = F ? m.crossOrigin : void 0,
            q = !!I?.src,
            K = this.hasImage(),
            V = Y ? `${w}: ${Y}` : w,
            J = "LOADING" === W || "LOADED" === W,
            Q = K ? "found" : "not-found",
            X = "UNLOADED" === W || "UNLOADING" === W ? "hidden" : "visible";
          this.styleModalImg = K
            ? (({
                hasZoomImg: t,
                imgSrc: e,
                isSvg: i,
                isZoomed: n,
                loadedImgEl: o,
                offset: a,
                shouldRefresh: r,
                targetEl: h,
              }) => {
                let l = i || e?.slice?.(0, 18) === "data:image/svg+xml" || t || !!(e && v.test(e)),
                  d = h.getBoundingClientRect(),
                  m = window.getComputedStyle(h),
                  g = null != o && s(h),
                  p = null != o && !g,
                  w = (({
                    containerHeight: t,
                    containerLeft: e,
                    containerTop: i,
                    containerWidth: n,
                    hasScalableSrc: o,
                    offset: a,
                    targetHeight: s,
                    targetWidth: r,
                  }) => {
                    let h = c({
                      containerHeight: t,
                      containerWidth: n,
                      hasScalableSrc: o,
                      offset: a,
                      targetHeight: s,
                      targetWidth: r,
                    });
                    return {
                      top: i,
                      left: e,
                      width: n * h,
                      height: t * h,
                      transform: `translate(0,0) scale(${1 / h})`,
                    };
                  })({
                    containerHeight: d.height,
                    containerLeft: d.left,
                    containerTop: d.top,
                    containerWidth: d.width,
                    hasScalableSrc: l,
                    offset: a,
                    targetHeight: o?.naturalHeight || d.height,
                    targetWidth: o?.naturalWidth || d.width,
                  }),
                  f = Object.assign(
                    {},
                    w,
                    p
                      ? (({
                          containerHeight: t,
                          containerLeft: e,
                          containerTop: i,
                          containerWidth: n,
                          hasScalableSrc: o,
                          objectFit: a,
                          objectPosition: s,
                          offset: r,
                          targetHeight: h,
                          targetWidth: l,
                        }) => {
                          if (
                            ("scale-down" === a && (a = l <= n && h <= t ? "none" : "contain"),
                            "cover" === a || "contain" === a)
                          ) {
                            let d = n / l,
                              m = t / h,
                              g = "cover" === a ? Math.max(d, m) : Math.min(d, m),
                              [v = "50%", p = "50%"] = s.split(" "),
                              w = u({ position: v, relativeNum: n - l * g }),
                              f = u({ position: p, relativeNum: t - h * g }),
                              E = c({
                                containerHeight: h * g,
                                containerWidth: l * g,
                                hasScalableSrc: o,
                                offset: r,
                                targetHeight: h,
                                targetWidth: l,
                              });
                            return {
                              top: i + f,
                              left: e + w,
                              width: l * g * E,
                              height: h * g * E,
                              transform: `translate(0,0) scale(${1 / E})`,
                            };
                          }
                          if ("none" === a) {
                            let [a = "50%", d = "50%"] = s.split(" "),
                              m = u({ position: a, relativeNum: n - l }),
                              g = u({ position: d, relativeNum: t - h }),
                              v = c({
                                containerHeight: h,
                                containerWidth: l,
                                hasScalableSrc: o,
                                offset: r,
                                targetHeight: h,
                                targetWidth: l,
                              });
                            return {
                              top: i + g,
                              left: e + m,
                              width: l * v,
                              height: h * v,
                              transform: `translate(0,0) scale(${1 / v})`,
                            };
                          }
                          if ("fill" !== a) {
                            return {};
                          }
                          {
                            let e = Math.max(n / l, t / h),
                              i = c({
                                containerHeight: h * e,
                                containerWidth: l * e,
                                hasScalableSrc: o,
                                offset: r,
                                targetHeight: h,
                                targetWidth: l,
                              });
                            return {
                              width: n * i,
                              height: t * i,
                              transform: `translate(0,0) scale(${1 / i})`,
                            };
                          }
                        })({
                          containerHeight: d.height,
                          containerLeft: d.left,
                          containerTop: d.top,
                          containerWidth: d.width,
                          hasScalableSrc: l,
                          objectFit: m.objectFit,
                          objectPosition: m.objectPosition,
                          offset: a,
                          targetHeight: o?.naturalHeight || d.height,
                          targetWidth: o?.naturalWidth || d.width,
                        })
                      : void 0,
                    g
                      ? (({
                          backgroundPosition: t,
                          backgroundSize: e,
                          containerHeight: i,
                          containerLeft: n,
                          containerTop: o,
                          containerWidth: a,
                          hasScalableSrc: s,
                          offset: r,
                          targetHeight: h,
                          targetWidth: l,
                        }) => {
                          if ("cover" === e || "contain" === e) {
                            let d = a / l,
                              m = i / h,
                              g = "cover" === e ? Math.max(d, m) : Math.min(d, m),
                              [v = "50%", p = "50%"] = t.split(" "),
                              w = u({ position: v, relativeNum: a - l * g }),
                              f = u({ position: p, relativeNum: i - h * g }),
                              E = c({
                                containerHeight: h * g,
                                containerWidth: l * g,
                                hasScalableSrc: s,
                                offset: r,
                                targetHeight: h,
                                targetWidth: l,
                              });
                            return {
                              top: o + f,
                              left: n + w,
                              width: l * g * E,
                              height: h * g * E,
                              transform: `translate(0,0) scale(${1 / E})`,
                            };
                          }
                          if ("auto" === e) {
                            let [e = "50%", d = "50%"] = t.split(" "),
                              m = u({ position: e, relativeNum: a - l }),
                              g = u({ position: d, relativeNum: i - h }),
                              v = c({
                                containerHeight: h,
                                containerWidth: l,
                                hasScalableSrc: s,
                                offset: r,
                                targetHeight: h,
                                targetWidth: l,
                              });
                            return {
                              top: o + g,
                              left: n + m,
                              width: l * v,
                              height: h * v,
                              transform: `translate(0,0) scale(${1 / v})`,
                            };
                          }
                          {
                            let [d = "50%", m = "50%"] = e.split(" "),
                              g = u({ position: d, relativeNum: a }),
                              v = Math.min(g / l, u({ position: m, relativeNum: i }) / h),
                              [p = "50%", w = "50%"] = t.split(" "),
                              f = u({ position: p, relativeNum: a - l * v }),
                              E = u({ position: w, relativeNum: i - h * v }),
                              L = c({
                                containerHeight: h * v,
                                containerWidth: l * v,
                                hasScalableSrc: s,
                                offset: r,
                                targetHeight: h,
                                targetWidth: l,
                              });
                            return {
                              top: o + E,
                              left: n + f,
                              width: l * v * L,
                              height: h * v * L,
                              transform: `translate(0,0) scale(${1 / L})`,
                            };
                          }
                        })({
                          backgroundPosition: m.backgroundPosition,
                          backgroundSize: m.backgroundSize,
                          containerHeight: d.height,
                          containerLeft: d.left,
                          containerTop: d.top,
                          containerWidth: d.width,
                          hasScalableSrc: l,
                          offset: a,
                          targetHeight: o?.naturalHeight || d.height,
                          targetWidth: o?.naturalWidth || d.width,
                        })
                      : void 0,
                  );
                if (n) {
                  let t = window.innerWidth / 2,
                    e = window.innerHeight / 2,
                    i = parseFloat(String(f.left || 0)) + parseFloat(String(f.width || 0)) / 2,
                    n = parseFloat(String(f.top || 0)) + parseFloat(String(f.height || 0)) / 2;
                  (r && (f.transitionDuration = "0.01ms"),
                    (f.transform = `translate(${t - i}px,${e - n}px) scale(1)`));
                }
                return f;
              })({
                hasZoomImg: q,
                imgSrc: B,
                isSvg: G,
                isZoomed: S && J,
                loadedImgEl: k,
                offset: C,
                shouldRefresh: $,
                targetEl: m,
              })
            : {};
          let tt = null;
          if (K) {
            let e =
                F || R
                  ? n.createElement("img", {
                      alt: Y,
                      crossOrigin: _,
                      sizes: P,
                      src: B,
                      srcSet: j,
                      ...(U && "LOADED" === W ? I : {}),
                      "data-rmiz-modal-img": "",
                      height: this.styleModalImg.height || void 0,
                      id: H,
                      ref: M,
                      style: this.styleModalImg,
                      width: this.styleModalImg.width || void 0,
                    })
                  : G
                    ? n.createElement("div", {
                        "data-rmiz-modal-img": !0,
                        ref: M,
                        style: this.styleModalImg,
                      })
                    : null,
              i = n.createElement(
                "button",
                { "aria-label": p, "data-rmiz-btn-unzoom": "", onClick: t, type: "button" },
                n.createElement(L, null),
              );
            tt = z
              ? n.createElement(z, { buttonUnzoom: i, modalState: W, img: e, onUnzoom: h })
              : n.createElement(n.Fragment, null, e, i);
          }
          return n.createElement(
            y,
            { "aria-owns": Z, "data-rmiz": "", ref: O },
            n.createElement(
              y,
              {
                "data-rmiz-content": Q,
                ref: D,
                style: { visibility: "UNLOADED" === W ? "visible" : "hidden" },
              },
              f,
            ),
            K &&
              n.createElement(
                y,
                { "data-rmiz-ghost": "", style: x },
                n.createElement(
                  "button",
                  { "aria-label": V, "data-rmiz-btn-zoom": "", onClick: d, type: "button" },
                  n.createElement(b, null),
                ),
              ),
            K &&
              o.createPortal(
                n.createElement(
                  "dialog",
                  {
                    "aria-labelledby": H,
                    "aria-modal": "true",
                    className: E,
                    "data-rmiz-modal": "",
                    id: Z,
                    onClick: i,
                    onClose: a,
                    onCancel: e,
                    ref: N,
                    role: "dialog",
                  },
                  n.createElement("div", { "data-rmiz-modal-overlay": X }),
                  n.createElement("div", { "data-rmiz-modal-content": "", ref: T }, tt),
                ),
                this.getDialogContainer(),
              ),
          );
        }
        componentDidMount() {
          (this.setId(), this.setAndTrackImg(), this.handleImgLoad(), this.UNSAFE_handleSvg());
        }
        componentWillUnmount() {
          ("UNLOADED" !== this.state.modalState && this.bodyScrollEnable(),
            this.contentChangeObserver?.disconnect?.(),
            this.contentNotFoundChangeObserver?.disconnect?.(),
            this.imgElResizeObserver?.disconnect?.(),
            this.imgEl?.removeEventListener?.("load", this.handleImgLoad),
            this.imgEl?.removeEventListener?.("click", this.handleZoom),
            this.refModalImg.current?.removeEventListener?.(
              "transitionend",
              this.handleImgTransitionEnd,
            ),
            window.removeEventListener("wheel", this.handleWheel),
            window.removeEventListener("touchstart", this.handleTouchStart),
            window.removeEventListener("touchmove", this.handleTouchMove),
            window.removeEventListener("touchend", this.handleTouchEnd),
            window.removeEventListener("touchcancel", this.handleTouchCancel),
            window.removeEventListener("resize", this.handleResize),
            document.removeEventListener("keydown", this.handleKeyDown, !0));
        }
        componentDidUpdate(t, e) {
          (this.handleModalStateChange(e.modalState),
            this.UNSAFE_handleSvg(),
            this.handleIfZoomChanged(t.isZoomed));
        }
      }
      function b(t) {
        let [e, i] = n.useState(!1);
        return n.createElement(E, { ...t, isZoomed: e, onZoomChange: i });
      }
      L.defaultProps = {
        a11yNameButtonUnzoom: "Minimize image",
        a11yNameButtonZoom: "Expand image",
        canSwipeToUnzoom: !0,
        IconUnzoom: function () {
          return n.createElement(
            "svg",
            {
              "aria-hidden": "true",
              "data-rmiz-btn-unzoom-icon": !0,
              fill: "currentColor",
              focusable: "false",
              viewBox: "0 0 16 16",
              xmlns: "http://www.w3.org/2000/svg",
            },
            n.createElement("path", {
              d: "M 14.144531 1.148438 L 9 6.292969 L 9 3 L 8 3 L 8 8 L 13 8 L 13 7 L 9.707031 7 L 14.855469 1.851563 Z M 8 8 L 3 8 L 3 9 L 6.292969 9 L 1.148438 14.144531 L 1.851563 14.855469 L 7 9.707031 L 7 13 L 8 13 Z",
            }),
          );
        },
        IconZoom: function () {
          return n.createElement(
            "svg",
            {
              "aria-hidden": "true",
              "data-rmiz-btn-zoom-icon": !0,
              fill: "currentColor",
              focusable: "false",
              viewBox: "0 0 16 16",
              xmlns: "http://www.w3.org/2000/svg",
            },
            n.createElement("path", {
              d: "M 9 1 L 9 2 L 12.292969 2 L 2 12.292969 L 2 9 L 1 9 L 1 14 L 6 14 L 6 13 L 2.707031 13 L 13 2.707031 L 13 6 L 14 6 L 14 1 Z",
            }),
          );
        },
        swipeToUnzoomThreshold: 10,
        wrapElement: "div",
        zoomMargin: 0,
      };
    },
  },
]);
