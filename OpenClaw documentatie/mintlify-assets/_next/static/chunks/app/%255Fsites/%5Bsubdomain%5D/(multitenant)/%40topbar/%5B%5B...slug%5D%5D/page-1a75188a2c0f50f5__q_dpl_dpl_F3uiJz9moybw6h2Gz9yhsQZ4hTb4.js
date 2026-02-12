(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [30703, 83378],
  {
    1221: (e, s, i) => {
      "use strict";
      i.d(s, { TopBar: () => x });
      var t = i(54568),
        d = i(7620),
        r = i(71252),
        n = i(27194),
        a = i(84246),
        c = i(35878),
        o = i(61664),
        m = i(98849),
        p = i(7824),
        h = i(98046),
        l = i(13380),
        u = i(32795),
        N = i(6816),
        f = i(81325),
        C = i(840);
      function g({ theme: e, pageMetadata: s }) {
        let { isCustom: i, isCenter: d, isWide: r, isFrame: n } = (0, C.H)(s),
          g = [
            i ? a.N.isCustom : a.N.isNotCustom,
            d ? a.N.isCenter : a.N.isNotCenter,
            r ? a.N.isWide : a.N.isNotWide,
            n ? a.N.isFrame : a.N.isNotFrame,
          ],
          x = (0, f.cn)(...g),
          v = (0, t.jsx)("div", { id: c.V.Navbar, className: (0, f.cn)("hidden", x) });
        switch (e) {
          case "maple":
          case "willow":
            return (0, t.jsx)(N.DefaultTopbar, { pageModeClasses: g });
          case "palm":
            return i ? v : (0, t.jsx)(h.PalmTopBar, { className: x, pageMetadata: s });
          case "linden":
            return (0, t.jsx)(p.TopBar, { className: x, pageMetadata: s });
          case "aspen":
            return (0, t.jsx)(m.AspenTopBar, { className: x, pageMetadata: s });
          case "almond":
            return i ? v : (0, t.jsx)(o.AlmondTopBar, { className: x, pageMetadata: s });
          case "sequoia":
            return (0, t.jsx)(l.SequoiaTopBar, { className: x, pageMetadata: s });
          default:
            return (0, t.jsx)(u.Vs, { className: x, pageMetadata: s });
        }
      }
      let x = ({ pageMetadata: e, docsConfig: s }) => {
        let i = (0, n.G)(),
          { isLivePreview: a, getDocsConfigOverrides: c, liveMetadata: o } = (0, d.useContext)(r.K),
          m = c()?.theme,
          p = a && m ? m : s.theme,
          h = (0, d.useMemo)(() => {
            if (a) {
              let e = o.get(i);
              if (e) {
                return e;
              }
            }
            return e;
          }, [a, o, i, e]);
        return (0, t.jsx)(g, { theme: p, pageMetadata: h });
      };
    },
    49285: (e, s, i) => {
      Promise.resolve().then(i.bind(i, 1221));
    },
    84246: (e, s, i) => {
      "use strict";
      i.d(s, { N: () => t });
      let t = {
        isCustom: "peer is-custom",
        isCenter: "peer is-center",
        isWide: "peer is-wide",
        isFrame: "peer is-frame",
        isNotCustom: "peer is-not-custom",
        isNotCenter: "peer is-not-center",
        isNotWide: "peer is-not-wide",
        isNotFrame: "peer is-not-frame",
        hiddenIfCustom:
          "peer-[.is-custom]:!hidden peer-[.is-custom]:sm:!hidden peer-[.is-custom]:md:!hidden peer-[.is-custom]:lg:!hidden peer-[.is-custom]:xl:!hidden",
        hiddenIfNotCustom:
          "peer-[.is-not-custom]:!hidden peer-[.is-not-custom]:sm:!hidden peer-[.is-not-custom]:md:!hidden peer-[.is-not-custom]:lg:!hidden peer-[.is-not-custom]:xl:!hidden",
        hiddenIfCenter:
          "peer-[.is-center]:!hidden peer-[.is-center]:sm:!hidden peer-[.is-center]:md:!hidden peer-[.is-center]:lg:!hidden peer-[.is-center]:xl:!hidden",
        firstChildHiddenIfCustom:
          "peer-[.is-custom]:[&>div:first-child]:!hidden peer-[.is-custom]:[&>div:first-child]:sm:!hidden peer-[.is-custom]:[&>div:first-child]:md:!hidden peer-[.is-custom]:[&>div:first-child]:lg:!hidden peer-[.is-custom]:[&>div:first-child]:xl:!hidden",
        firstChildHiddenIfCenter:
          "peer-[.is-center]:[&>div:first-child]:!hidden peer-[.is-center]:[&>div:first-child]:sm:!hidden peer-[.is-center]:[&>div:first-child]:md:!hidden peer-[.is-center]:[&>div:first-child]:lg:!hidden peer-[.is-center]:[&>div:first-child]:xl:!hidden",
      };
    },
  },
  (e) => {
    (e.O(
      0,
      [
        67903, 73473, 53016, 41725, 82431, 43881, 98816, 75321, 19664, 21246, 97374, 62767, 79845,
        18697, 73205, 14224, 61706, 86707, 25263, 45960, 587, 90018, 77358,
      ],
      () => e((e.s = 49285)),
    ),
      (_N_E = e.O()));
  },
]);
