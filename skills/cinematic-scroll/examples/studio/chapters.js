/* ============================================================================
   Maya Torres — Creative Director portfolio (brutalist / Swiss editorial)
   Single source of truth for BOTH the page (index.html) and the image
   generator (generate.mjs). Fictional persona — no real people or brands.

   Aesthetic: monochrome (ink / greys / white) + one electric-blue accent.
   Motion: full cinematic scroll — pinned chapters, giant-grotesk type reveals,
   imagery parallaxing UNDER the type, grey→white→ink background morph.
   ========================================================================== */

export const ACCENT = '#0F4CFF';          // electric blue — accent words + CTA
export const PALETTE = {
  ink:   '#111113',
  grey:  '#E6E6E6',
  grey2: '#D4D4D6',
  white: '#FFFFFF',
  muted: '#6B6B70',
  accent: ACCENT,
};

/* Each chapter:
   - id           folder-safe slug → asset filename (assets/<id>.jpg)
   - eyebrow      small mono label
   - title        array of [word, accent?]  (accent:1 → electric-blue word)
   - body         supporting paragraph (creative-director voice)
   - card         floating mono UI artifact { tag, body }
   - fig / figLabel  bottom caption for the framed still
   - morph        background colour this chapter morphs TO (grey↔white↔ink)
   - depthTextDark  true → type is white on dark morph; false → ink on light
   - prompt       Nano Banana Pro image prompt (monochrome, NO text/logos)
*/
export const CHAPTERS = [
  {
    id: '0-hero',
    eyebrow: 'CREATIVE DIRECTION · PORTFOLIO MMXXVI',
    title: [['MAYA', 0], ['TORRES', 1]],
    body: 'Global Creative Director. Two decades turning products into culture — and the last twelve years shaping how the world feels about the objects in its pockets.',
    card: { tag: '/role', body: 'Global Creative Director · Brand, film, product. Blank page to final cut.' },
    fig: 'FIG. 00', figLabel: 'PORTRAIT, UNTITLED',
    morph: '#E6E6E6', depthTextDark: false,
    prompt: 'High-contrast black-and-white editorial portrait of a confident creative director in their late 30s, dramatic single-source studio light, deep shadows, fine film grain, minimalist grey seamless background, shot on medium format, no text, no logos, fashion-editorial restraint, cinematic monochrome'
  },
  {
    id: '1-belief',
    eyebrow: 'THE BELIEF',
    title: [['Great work earns', 0], ['its place in culture.', 1]],
    body: 'Creative that does not enter the conversation is decoration. Every brief starts with one question: will anyone outside this room care? If not, we start again.',
    card: { tag: '/principle', body: 'Earn attention. Never assume it. Culture is the only real KPI.' },
    fig: 'FIG. 01', figLabel: 'THE STUDIO FLOOR',
    morph: '#FFFFFF', depthTextDark: false,
    prompt: 'Black-and-white documentary photograph of an empty modern creative studio at dawn, raw concrete floor, large windows, a single chair, long shadows, high contrast, fine grain, architectural minimalism, vast negative space, no people, no text, no logos, monochrome editorial'
  },
  {
    id: '2-work',
    eyebrow: 'THE WORK',
    title: [['Twelve years.', 0], ['One obsession.', 1]],
    body: 'Wearables, audio, the small devices that became extensions of the body. Launch films, platform campaigns, the kind of product storytelling that turns a spec sheet into a feeling.',
    card: { tag: '/output', body: '40+ global launches · film, OOH, platform. Synced across 28 markets.' },
    fig: 'FIG. 02', figLabel: 'PRODUCT STUDY, ABSTRACT',
    morph: '#111113', depthTextDark: true,
    prompt: 'Abstract macro photograph of a sculptural premium consumer-electronics form in brushed aluminium and matte black, floating on pure black, single dramatic rim light, glossy reflections, no recognisable brand, no logos, no text, high-contrast monochrome product photography, museum lighting, fine grain'
  },
  {
    id: '3-craft',
    eyebrow: 'THE CRAFT',
    title: [['The messy,', 0], ['meaningful middle.', 1]],
    body: 'I live between the blank page and the final release — leading multidisciplinary teams that feel safe taking real creative risks. Storytelling, positioning, design direction, and the trust that lets a team be brave.',
    card: { tag: '/process', body: 'Multidisciplinary team of 14 · safe to fail, built to ship.' },
    fig: 'FIG. 03', figLabel: 'PROCESS, IN MOTION',
    morph: '#D4D4D6', depthTextDark: false,
    prompt: 'Black-and-white motion-blurred photograph of hands arranging printed storyboards and contact sheets on a large table, overhead light, scattered film stills, intense focus, documentary grain, high contrast, no faces, no text, no logos, monochrome editorial reportage'
  },
  {
    id: '4-recognition',
    eyebrow: 'RECOGNITION',
    title: [['Grand', 0], ['Prix.', 1]],
    body: 'A Grand Prix at the world’s largest creative festival. A Pencil for cultural impact. The recognition matters only because of what it represents — work that moved people, at scale.',
    card: { tag: '/awards', body: 'Grand Prix · Pencil for impact · 11 metals across film + craft.' },
    fig: 'FIG. 04', figLabel: 'THE TROPHY, BACKLIT',
    morph: '#111113', depthTextDark: true,
    prompt: 'Dramatic black-and-white still life of an abstract minimalist award trophy form, a tall geometric monolith, single hard backlight creating a halo, deep black surroundings, glossy reflections, fine grain, no text, no logos, no engraving, high-contrast monochrome, gallery lighting'
  },
  {
    id: '5-invitation',
    eyebrow: 'THE INVITATION',
    title: [['Let’s make work', 0], ['that matters.', 1]],
    body: 'I’m looking to partner with ambitious brands and collaborators who believe in brave ideas. If that’s you, the page is blank and the cursor is blinking.',
    card: { tag: '/contact', body: 'Open to select partnerships · global · remote-first.' },
    fig: 'FIG. 05', figLabel: 'THE OPEN PAGE',
    morph: '#FFFFFF', depthTextDark: false,
    prompt: 'Minimalist black-and-white photograph of a single blank sheet of heavy paper on a vast empty desk, one shaft of hard window light, long shadow, immense negative space, fine grain, high contrast, no text, no logos, no writing, monochrome editorial, quiet and confident'
  },
];

/* MONTAGE — a brutalist "contact sheet" of selected work, shown as a single
   GSAP-pinned + snap section (cinematic "Montage", taste-guardrails §2;
   scroll-patterns.md "Landing Sequence" snap config). CSS-only numbered tiles,
   no image assets. Index = filing number; year + discipline as mono metadata. */
export const MONTAGE = [
  { idx: '01', year: '2014', label: 'Wearable launch film', meta: 'FILM · GLOBAL' },
  { idx: '02', year: '2017', label: 'Audio platform identity', meta: 'BRAND · 28 MKTS' },
  { idx: '03', year: '2020', label: 'Pocket-device campaign', meta: 'OOH · PLATFORM' },
  { idx: '04', year: '2023', label: 'Grand Prix anthem', meta: 'FILM · CRAFT' },
  { idx: '05', year: '2026', label: 'The next blank page', meta: 'OPEN · TBD' },
];
