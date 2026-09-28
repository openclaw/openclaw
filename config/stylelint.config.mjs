// Control UI CSS hygiene: plain stylesheets plus css`` templates in Lit
// components (postcss-lit). Error-class rules only — oxfmt owns formatting.
const selectorFunction = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
const selectorTail = String.raw`(?:[^([]|${selectorFunction}|\[[^\]]*\])*`;

export default {
  extends: "stylelint-config-recommended",
  rules: {
    // Chromium builds one invalidation set for every non-subject :has(). A universal
    // selector or pseudo-element after one widens it to whole subtrees (~9 ms per
    // insertion with 534 messages), ::placeholder on the :has() compound cost ~8 ms, and
    // a tick after a sibling-relative :has() restyled every position-rail tick per
    // transcript row. Style the element directly, or set a state class or custom
    // property on the :has() subject. Functional arguments and attributes are skipped;
    // split lists keep safe branches independent.
    "selector-disallowed-list": [
      [
        new RegExp(
          `:has${selectorFunction}${selectorTail}[\\s>+~](?:${selectorTail}[\\s>+~(])?\\*`,
          "i",
        ),
        new RegExp(`:has${selectorFunction}${selectorTail}[\\s>+~]${selectorTail}::`, "i"),
        new RegExp(`:has${selectorFunction}${selectorTail}::placeholder(?![\\w-])`, "i"),
        new RegExp(`:has(?=\\(\\s*[+~])${selectorFunction}${selectorTail}[\\s>+~]`, "i"),
      ],
      { splitList: true },
    ],
    // Cascade-order advice, not an error class; 400+ intentional hits in the
    // existing token/override cascade make it pure noise here.
    "no-descending-specificity": null,
    // `clip` survives only inside the standard sr-only fallback pattern.
    "property-no-deprecated": [true, { ignoreProperties: ["clip"] }],
    // `word-break: break-word` is deprecated but swapping it for overflow-wrap
    // changes min-content sizing in flex/grid text containers.
    "declaration-property-value-keyword-no-deprecated": [true, { ignoreKeywords: ["break-word"] }],
  },
  overrides: [
    {
      files: ["**/*.css"],
      rules: {
        "color-no-hex": true,
        // Control UI max-width breakpoints use one ladder: 400, 560, 640,
        // 768, 900, 1100, and 1320px. Round thresholds up to the next rung
        // so compact layouts engage before desktop layouts become cramped.
        "media-feature-name-value-allowed-list": {
          "max-width": ["400px", "560px", "640px", "768px", "900px", "1100px", "1320px", "932px"],
          "max-height": ["500px"],
          "min-width": ["769px", "933px", "1121px", "1400px", "1600px"],
        },
      },
    },
    {
      // Theme token definitions are the one source of stylesheet hex colors.
      files: ["../ui/src/styles/base.css", "../ui/public/themes/*.css"],
      rules: {
        "color-no-hex": null,
      },
    },
    {
      // Lobster sprite artwork owns a fixed illustration palette, not UI theme colors.
      files: ["../ui/src/styles/lobster-pet.css"],
      rules: {
        "color-no-hex": null,
      },
    },
    {
      files: ["**/*.ts"],
      customSyntax: "postcss-lit",
    },
  ],
};
