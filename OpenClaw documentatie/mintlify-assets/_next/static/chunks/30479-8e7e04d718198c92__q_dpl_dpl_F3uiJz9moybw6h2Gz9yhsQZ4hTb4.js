"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [30479],
  {
    11533: (e, t, o) => {
      (o.r(t), o.d(t, { NotFoundComponent: () => u, SupportLink: () => p }));
      var r = o(54568),
        n = o(19664),
        a = o.n(n),
        i = o(7620),
        d = o(30793),
        l = o(33052),
        c = o(81325),
        s = o(48622);
      function u({ content: e, recommendPages: t }) {
        let { docsConfig: o } = (0, i.useContext)(d.DocsConfigContext),
          n = o?.errors?.[404].title;
        return (0, r.jsxs)("div", {
          className: (0, c.cn)(
            "flex flex-col items-center justify-center w-full max-w-lg overflow-x-hidden mx-auto py-48 px-5 text-center *:text-center gap-y-8",
            l.x.NotFoundContainer,
          ),
          children: [
            (0, r.jsxs)("div", {
              className: "flex flex-col items-center justify-center gap-y-6",
              children: [
                (0, r.jsx)("span", {
                  id: "error-badge",
                  className: (0, c.cn)(
                    "inline-flex -mb-2 text-5xl font-semibold p-1 text-primary dark:text-primary-light",
                    l.x.NotFoundStatusCode,
                  ),
                  children: "404",
                }),
                (0, r.jsx)("h1", {
                  id: "error-title",
                  className: (0, c.cn)(
                    "font-medium mb-0 text-2xl text-gray-800 dark:text-gray-200",
                    l.x.NotFoundTitle,
                  ),
                  children: n ?? "Page Not Found",
                }),
                (0, r.jsx)("div", {
                  id: "error-description",
                  className: (0, c.cn)(
                    "flex flex-col items-center gap-y-6 prose prose-gray dark:prose-invert",
                    l.x.NotFoundDescription,
                  ),
                  children: e,
                }),
              ],
            }),
            (0, r.jsx)(s.RecommendedPagesList, { recommendPages: t }),
          ],
        });
      }
      function p() {
        return (0, r.jsx)(a(), {
          href: "mailto:support@mintlify.com",
          className:
            "font-medium text-gray-700 dark:text-gray-100 border-b hover:border-b-[2px] border-primary-dark dark:border-primary-light",
          children: "contact support",
        });
      }
    },
    24223: (e, t, o) => {
      o.d(t, { RoundedVariables: () => i });
      var r = o(54568),
        n = o(7620),
        a = o(71252);
      function i({ theme: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: o } = (0, n.useContext)(a.K),
          i = o(),
          d = i?.theme;
        if ("linden" !== (t && d ? d : e)) {
          return null;
        }
        {
          let e = `:root {
      --rounded-sm: 4px;
      --rounded: 4px;
      --rounded-md: 4px;
      --rounded-lg: 4px;
      --rounded-xl: 4px;
      --rounded-xt: 4px;
      --rounded-2xl: 4px;
      --rounded-search: 4px;
      --rounded-3xl: 4px;
      --rounded-full: 4px;
  }`;
          return (0, r.jsx)("style", { children: e });
        }
      }
    },
    30479: (e, t, o) => {
      o.d(t, { z: () => u });
      var r = o(54568),
        n = o(10897),
        a = o(51749),
        i = o(17644),
        d = o(35021),
        l = o(24223),
        c = o(48622),
        s = o(11533);
      function u({ statusCode: e, title: t, description: o }) {
        let u = "#4ADE80",
          p = `:root {
  --primary: ${(0, n.N9)("#117866")};
  --primary-light: ${(0, n.N9)(u)};
  --primary-dark: ${(0, n.N9)("#166534")};
  --background-light: ${(0, n.N9)("#FFFFFF")};
  --background-dark: ${(0, n.ab)(u, "#0f1117")};
}`;
        return (0, r.jsxs)(a.ThemeProvider, {
          children: [
            (0, r.jsx)(d.ColorVariables, {}),
            (0, r.jsx)(i.FontScript, {}),
            (0, r.jsx)(l.RoundedVariables, {}),
            (0, r.jsx)("style", { children: p }),
            (0, r.jsx)("main", {
              className: "h-screen bg-background-light dark:bg-background-dark text-left",
              children: (0, r.jsx)("article", {
                className:
                  "bg-custom bg-fixed bg-center bg-cover relative flex flex-col items-center justify-center h-full",
                children: (0, r.jsxs)("div", {
                  className: "w-full max-w-xl px-10",
                  children: [
                    (0, r.jsxs)("span", {
                      className:
                        "inline-flex mb-6 rounded-full px-3 py-1 text-sm font-semibold mr-4 text-white p-1 bg-primary",
                      children: ["Error ", e],
                    }),
                    (0, r.jsx)("h1", {
                      className: "font-semibold mb-3 text-3xl",
                      children: t ?? "Page not found!",
                    }),
                    (0, r.jsx)("p", {
                      className: "text-lg text-gray-600 dark:text-gray-400 mb-6",
                      children:
                        o ??
                        (function (e, t) {
                          switch (e) {
                            case 404:
                              return "We couldn't find the page.";
                            case 500:
                              return (0, r.jsxs)(r.Fragment, {
                                children: [
                                  "An unexpected error occurred. Please ",
                                  (0, r.jsx)(s.SupportLink, {}),
                                  " to get help.",
                                ],
                              });
                            default:
                              return "An unexpected error occurred. Please contact support.";
                          }
                        })(e),
                    }),
                    (0, r.jsx)(c.RecommendedPagesList, {}),
                  ],
                }),
              }),
            }),
          ],
        });
      }
    },
    33052: (e, t, o) => {
      o.d(t, { x: () => r });
      let r = Object.fromEntries(
        Object.entries({
          Accordion: "accordion",
          AccordionGroup: "accordion-group",
          Callout: "callout",
          Card: "card",
          CardGroup: "card-group",
          CodeBlock: "code-block",
          CodeBlockIcon: "code-block-icon",
          CodeGroup: "code-group",
          Expandable: "expandable",
          Field: "field",
          Frame: "frame",
          Icon: "icon",
          Mermaid: "mermaid",
          Step: "step",
          Steps: "steps",
          Tab: "tab",
          Tabs: "tabs",
          TabIcon: "tab-icon",
          Update: "update",
          Tooltip: "tooltip",
          Panel: "panel",
          Prompt: "prompt",
          APISection: "api-section",
          APISectionHeading: "api-section-heading",
          APISectionHeadingTitle: "api-section-heading-title",
          APISectionHeadingSubtitle: "api-section-heading-subtitle",
          OptionDropdown: "option-dropdown",
          TryitButton: "tryit-button",
          MethodPill: "method-pill",
          MethodNavPill: "method-nav-pill",
          NavTagPill: "nav-tag-pill",
          NavTagPillText: "nav-tag-pill-text",
          Anchors: "nav-anchors",
          Anchor: "nav-anchor",
          TabsBar: "nav-tabs",
          TabsBarItem: "nav-tabs-item",
          MobileNavTabsBarItem: "mobile-nav-tabs-item",
          TableOfContents: "toc",
          TableOfContentsItem: "toc-item",
          Footer: "footer",
          AdvancedFooter: "advanced-footer",
          SidebarGroupIcon: "sidebar-group-icon",
          SidebarGroupHeader: "sidebar-group-header",
          SidebarTitle: "sidebar-title",
          SidebarGroup: "sidebar-group",
          SidebarNavGroupDivider: "sidebar-nav-group-divider",
          NavBarLink: "navbar-link",
          TopbarRightContainer: "topbar-right-container",
          Logo: "nav-logo",
          PaginationPrev: "pagination-prev",
          PaginationNext: "pagination-next",
          PaginationTitle: "pagination-title",
          FeedbackToolbar: "feedback-toolbar",
          Eyebrow: "eyebrow",
          BreadcrumbList: "breadcrumb-list",
          BreadcrumbItem: "breadcrumb-item",
          Content: "mdx-content",
          DropdownTrigger: "nav-dropdown-trigger",
          DropdownContent: "nav-dropdown-content",
          DropdownItem: "nav-dropdown-item",
          DropdownItemTextContainer: "nav-dropdown-item-text-container",
          DropdownItemTitle: "nav-dropdown-item-title",
          DropdownItemDescription: "nav-dropdown-item-description",
          DropdownItemIcon: "nav-dropdown-item-icon",
          ProductsSelectorTrigger: "nav-dropdown-products-selector-trigger",
          ProductsSelectorContent: "nav-dropdown-products-selector-content",
          ProductsSelectorItem: "nav-dropdown-products-selector-item",
          ProductsSelectorItemTitle: "nav-dropdown-products-selector-item-title",
          ProductsSelectorItemDescription: "nav-dropdown-products-selector-item-description",
          ProductsSelectorItemIcon: "nav-dropdown-products-selector-item-icon",
          Link: "link",
          AlmondLayout: "almond-layout",
          AlmondNavBottomSection: "almond-nav-bottom-section",
          AlmondNavBottomSectionDivider: "almond-nav-bottom-section-divider",
          ChatAssistantSheet: "chat-assistant-sheet",
          ChatAssistantSheetHeader: "chat-assistant-sheet-header",
          ChatAssistantSheetContent: "chat-assistant-sheet-content",
          ChatAssistantInput: "chat-assistant-input",
          ChatAssistantFloatingInput: "chat-assistant-floating-input",
          ChatAssistantSendButton: "chat-assistant-send-button",
          ChatAssistantDisclaimerText: "chat-assistant-disclaimer-text",
          ChatAssistantPayloadItem: "chat-assistant-payload-item",
          StarterQuestionText: "starter-question-text",
          LoginLink: "login-link",
          LogoutLink: "logout-link",
          ContextualFeedbackContainer: "contextual-feedback-container",
          ContextualFeedbackForm: "contextual-feedback-form",
          ContextualFeedbackFormTitle: "contextual-feedback-form-title",
          ContextualFeedbackFormInput: "contextual-feedback-input",
          ContextualFeedbackFormButton: "contextual-feedback-button",
          ContextualFeedbackFormSubmitButton: "contextual-feedback-form-submit-button",
          CodeSnippetFeedbackPopoverContent: "code-snippet-feedback-popover-content",
          CodeSnippetFeedbackForm: "code-snippet-feedback-form",
          CodeSnippetFeedbackButton: "code-snippet-feedback-button",
          CodeSnippetFeedbackTextArea: "code-snippet-feedback-textarea",
          CodeSnippetFeedbackFormTitle: "code-snippet-feedback-form-title",
          CodeSnippetFeedbackFormDescription: "code-snippet-feedback-form-description",
          CodeSnippetFeedbackFormSubmitButton: "code-snippet-feedback-form-submit-button",
          NotFoundContainer: "not-found-container",
          NotFoundStatusCode: "not-found-status-code",
          NotFoundTitle: "not-found-title",
          NotFoundDescription: "not-found-description",
          NotFoundLogo: "not-found-logo",
          NotFoundLogoContainer: "not-found-logo-container",
          NotFoundMessage: "not-found-message",
          NotFoundGoBackButton: "not-found-go-back-button",
          NotFoundGoBackArrow: "not-found-go-back-arrow",
          NotFoundGoBackText: "not-found-go-back-text",
          NotFoundRecommendedPagesList: "not-found-recommended-pages-list",
          NotFoundRecommendedPageLink: "not-found-recommended-page-link",
          MultiViewItem: "multi-view-item",
          MultiViewDropdown: "multi-view-dropdown",
          MultiViewDropdownTrigger: "multi-view-dropdown-trigger",
          MultiViewDropdownContent: "multi-view-dropdown-content",
          MultiViewDropdownItem: "multi-view-dropdown-item",
          Color: "color",
          ColorRow: "color-row",
          ColorItem: "color-item",
          Tile: "tile",
          Tree: "tree",
          TreeFolder: "tree-folder",
          TreeFile: "tree-file",
        }).map(([e, t]) => [e, `${t}`]),
      );
    },
    35021: (e, t, o) => {
      o.d(t, { C: () => d, ColorVariables: () => l });
      var r = o(54568),
        n = o(10897),
        a = o(7620),
        i = o(71252);
      function d(e) {
        let t = e?.colors.primary ?? "#16A34A",
          o = e?.colors.light ?? "#4ADE80",
          r = e?.colors.dark ?? "#166534",
          a = e?.colors.primary,
          i = e?.colors.primary;
        return (
          e?.theme === "linden" &&
            (e.background = {
              ...e.background,
              color: {
                light: e.background?.color?.light || (0, n.Ob)((0, n._x)("#FFFFFF", 1, t, 0.03)),
                dark: e.background?.color?.dark || (0, n.Ob)((0, n._x)("#09090B", 1, o, 0.03)),
              },
            }),
          {
            primary: (0, n.N9)(t),
            primaryLight: (0, n.N9)(o),
            primaryDark: (0, n.N9)(r),
            primaryDarkForeground: ((e) => {
              let t = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(e),
                o = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(e) ?? t;
              if (!o || !o[1] || !o[2] || !o[3]) {
                return !1;
              }
              let r = (e) => (1 === e.length ? e + e : e),
                n = parseInt(r(o[1]), 16),
                a = parseInt(r(o[2]), 16);
              return 0.299 * n + 0.587 * a + 0.114 * parseInt(r(o[3]), 16) > 165;
            })(r)
              ? "0 0 0"
              : "255 255 255",
            backgroundLight: (0, n.N9)(e?.background?.color?.light ?? "#ffffff"),
            backgroundDark: (0, n.ab)(o, e?.background?.color?.dark),
            anchorDefault: a,
            dropdownDefault: i,
            gray: (0, n.Eo)(t),
          }
        );
      }
      function l({ docsConfig: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: o } = (0, a.useContext)(i.K),
          n = o(),
          l = d(t && n ? { ...e, ...n } : e),
          c = `:root {
    --primary: ${l.primary};
    --primary-light: ${l.primaryLight};
    --primary-dark: ${l.primaryDark};
    --tooltip-foreground: ${l.primaryDarkForeground};
    --background-light: ${l.backgroundLight};
    --background-dark: ${l.backgroundDark};
    --gray-50: ${l.gray[50]};
    --gray-100: ${l.gray[100]};
    --gray-200: ${l.gray[200]};
    --gray-300: ${l.gray[300]};
    --gray-400: ${l.gray[400]};
    --gray-500: ${l.gray[500]};
    --gray-600: ${l.gray[600]};
    --gray-700: ${l.gray[700]};
    --gray-800: ${l.gray[800]};
    --gray-900: ${l.gray[900]};
    --gray-950: ${l.gray[950]};
  }`;
        return (0, r.jsx)("style", { children: c });
      }
    },
    48622: (e, t, o) => {
      o.d(t, { RecommendedPagesList: () => l });
      var r = o(54568),
        n = o(7620),
        a = o(98167),
        i = o(33052),
        d = o(81325);
      function l({ recommendPages: e = [] }) {
        let t = (0, n.useMemo)(
          () => (t) =>
            (function (e, t) {
              let o = new Map();
              t.forEach((e) => {
                let t = o.get(e.title) || [];
                o.set(e.title, [...t, e]);
              });
              let r = o.get(e.title) || [];
              if (r.length <= 1 || !e.breadcrumbs || e.breadcrumbs.length <= 1) {
                return [];
              }
              let n = r.filter((e) => e.breadcrumbs && e.breadcrumbs.length > 1);
              if (n.length <= 1) {
                return [];
              }
              let a = 1,
                i = Math.max(...n.map((e) => (e.breadcrumbs?.length || 1) - 1));
              for (; a <= i; ) {
                let t = Math.max(0, e.breadcrumbs.length - 1 - a),
                  o = e.breadcrumbs.length - 1,
                  r = e.breadcrumbs.slice(t, o);
                if (
                  n
                    .filter((t) => t !== e)
                    .every((e) => {
                      if (!e.breadcrumbs || e.breadcrumbs.length <= 1) {
                        return !0;
                      }
                      let t = Math.max(0, e.breadcrumbs.length - 1 - a),
                        o = e.breadcrumbs.length - 1,
                        n = e.breadcrumbs.slice(t, o);
                      return r.join("/") !== n.join("/");
                    })
                ) {
                  return r;
                }
                a++;
              }
              return [];
            })(t, e),
          [e],
        );
        return e.length > 0
          ? (0, r.jsx)("div", {
              className: (0, d.cn)(i.x.NotFoundRecommendedPagesList, "w-full flex flex-col gap-3"),
              children: e.map((e, o) => {
                let n = e.link.startsWith("/") ? e.link : `/${e.link}`,
                  l =
                    a.c.BASE_PATH && n.startsWith(a.c.BASE_PATH)
                      ? n.slice(a.c.BASE_PATH.length)
                      : n;
                return (0, r.jsxs)(
                  "a",
                  {
                    href: `${a.c.BASE_PATH}${l}`,
                    className: (0, d.cn)(
                      i.x.NotFoundRecommendedPageLink,
                      "text-base text-primary dark:text-primary-light hover:brightness-[0.75] dark:hover:brightness-[1.35] text-center min-w-0 truncate",
                    ),
                    children: [
                      t(e).length > 0 &&
                        (0, r.jsxs)("span", { children: [t(e).join(" / "), " - "] }),
                      (0, r.jsx)("span", { children: e.title }),
                    ],
                  },
                  o,
                );
              }),
            })
          : (0, r.jsx)(r.Fragment, {});
      }
    },
    51749: (e, t, o) => {
      o.d(t, { ThemeProvider: () => l });
      var r = o(54568),
        n = o(24560),
        a = o(7620),
        i = o(16816),
        d = o(71252);
      function l({ children: e, appearance: t, queryParamMode: o, codeblockTheme: l, ...c }) {
        let {
            isLivePreview: s,
            getDocsConfigOverrides: u,
            livePreviewUpdateId: p,
          } = (0, a.useContext)(d.K),
          m = u(),
          g = m?.appearance,
          b = m?.styling?.codeblocks,
          x = o && ["dark", "light", "system"].includes(o),
          h = s && b ? b : l;
        (0, i.px)(h);
        let f = x ? o : s && g?.default ? g.default : t?.default,
          k = x ? o : s && g?.strict ? g.default : t?.strict ? t.default : void 0;
        return (0, r.jsx)(
          n.N,
          {
            attribute: "class",
            disableTransitionOnChange: !0,
            defaultTheme: f,
            forcedTheme: k,
            storageKey: "isDarkMode",
            themes: ["dark", "light", "true", "false", "system"],
            value: { true: "dark", false: "light", dark: "dark", light: "light" },
            enableSystem: !0,
            ...c,
            children: e,
          },
          p,
        );
      }
    },
  },
]);
