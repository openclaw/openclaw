export const suppressedInlineImageFacts = () => [
  {
    path: "/tmp/described-missing.png",
    contentType: "image/png",
    hydrationSuppressed: true,
  },
  { path: "/tmp/inline.png", contentType: "image/png" },
];
