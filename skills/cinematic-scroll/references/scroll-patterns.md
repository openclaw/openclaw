# Scroll Patterns

> 12 proven patterns for cinematic scroll experiences.
> Each includes: use case, depth config, transition type, mobile strategy.

## Pattern Index

1. Pinned Hero
2. Scrubbed Timeline
3. Velocity-Reactive
4. Sticky Narrative
5. Chaptered Release
6. Parallax Gallery
7. 3D Product Orbit
8. Editorial Longread
9. Data Story
10. Landing Sequence
11. Portfolio Reveal
12. Archive Explorer

---

## 1. Pinned Hero

### Use Case
Full-viewport hero that pins while content reveals through scroll. Best for: brand introductions, product launches, dramatic openings.

### Depth Configuration
```
Layer 0 (0.15x): Gradient/sky background
Layer 1 (0.30x): Atmospheric texture / distant elements
Layer 2 (0.60x): Main subject / product image
Layer 3 (1.00x): Title text (pinned, scroll-revealed)
Layer 4 (1.20x): Foreground accent / floating label
```

### Scroll Behavior
- Pin duration: 200-300vh
- Title: Mask reveal (clip-path) over first 40% of pin
- Background: Subtle translateY drift (2-3% of viewport)
- Exit: Scale down to 0.95 + opacity fade in last 20%

### Transition
Crane shot downward to next section (translateY + slight rotateX)

### Mobile Strategy
- Disable pin below 768px; convert to static stacked layout
- Reduce depth layers to 3 (0.2x, 0.6x, 1.0x)
- Title reveal becomes simple opacity fade

### Performance Budget
- Max 5 layers composited
- No blur/filter animations
- will-change: transform on Layers 1-3 only

### When NOT to Use
- Content-heavy landing pages (SEO penalty from pinned empty space)
- Pages where users need to scan quickly (e.g., documentation)

---

## 2. Scrubbed Timeline

### Use Case
Scroll drives a timeline visualization. Events appear at computed scroll positions. Best for: product roadmaps, company history, process explanations.

### Depth Configuration
```
Layer 0 (0.10x): Background grid / decade markers
Layer 1 (0.25x): Connecting line (SVG stroke-dashoffset scrubbed)
Layer 2 (0.50x): Event cards (alternate left/right)
Layer 3 (0.85x): Milestone dots / progress indicator
Layer 4 (1.00x): Active event detail panel (sticky)
Layer 5 (1.10x): Floating year label (follows active event)
```

### Scroll Behavior
- Pin duration: 150-250vh per timeline segment
- Progress line: stroke-dashoffset maps 1:1 to scroll progress (GSAP DrawSVG or manual stroke-dasharray)
- Event cards: translateX from +/- 60px to 0 + opacity 0 to 1, triggered at event scroll position
- Active card: scale(1.03) + z-index elevation on arrival
- Milestone dots: fill color transition (#94a3b8 to #0f172a) over 40px scroll window
- Year label: translateY to follow active event center with 120ms CSS transition easing

### Scroll-Scrubbed Progress Bar
```
Implementation: GSAP ScrollTrigger with scrub: 0.5
Trigger: timeline container start "top top"
End: "bottom bottom"
Progress bar width: CSS transform scaleX(progress) on a fixed-position element
Update rate: synced to ScrollTrigger onUpdate (not RAF loop)
```

### Transition
Horizontal wipe or fade-through-black to next section. Use clip-path: inset(0 0 0 0) to clip-path: inset(0 0 0 100%) with 600ms duration.

### Mobile Strategy
- Below 768px: switch to vertical card stack, no horizontal offsets
- Disable connecting line animation; show as static SVG
- Touch: snap to nearest event on scroll end (ScrollTrigger snap with distance-aware duration)
- Reduce depth layers to 3 (0.1x grid, 0.5x cards, 1.0x detail panel)

### Performance Budget
- Max 8 timeline events per viewport
- SVG path animations: use stroke-dashoffset only (no stroke morphing)
- will-change: transform on event cards only during their active scroll window
- Connecting line: will-change: stroke-dashoffset

### When NOT to Use
- Timelines with >20 events (break into chaptered segments instead)
- Content where event order is not chronological (defeats the scroll metaphor)
- Print-focused pages where exact vertical spacing matters

---

## 3. Velocity-Reactive

### Use Case
Elements react to scroll speed. Fast scroll = compressed/urgent visuals. Slow = expanded/editorial. Best for: immersive storytelling, editorial sites, gallery experiences.

### Depth Configuration
```
Layer 0 (0.10x): Background — subtle scaleY compression (0.98 at max velocity)
Layer 1 (0.30x): Image grid — column gap narrows on fast scroll (32px to 8px)
Layer 2 (0.60x): Headlines — letter-spacing compresses (0.02em to -0.03em)
Layer 3 (0.90x): Body text — opacity fades to 0.4 on fast scroll
Layer 4 (1.20x): Foreground accents — skewX increases (0deg to 3deg) with velocity direction
```

### Scroll Behavior
- Velocity detection: compute deltaY / deltaTime in RAF loop, windowed over last 3 frames
- Velocity thresholds (px/ms):
  - < 0.5: "editorial" mode — expanded spacing, full opacity
  - 0.5-1.5: "transitional" — gradual blend between states
  - > 1.5: "compressed" mode — tight spacing, reduced opacity, subtle compression
- Lerp factor: 0.15 per frame for smooth transitions between velocity states
- Max velocity cap: 3.0 px/ms (prevents visual breakage on scroll wheel burst)
- Direction detection: positive = down-scroll, negative = up-scroll; used for skewX direction

### GSAP Implementation
```
// Velocity tracker (run in RAF loop, not scroll event)
let lastScrollY = 0;
let lastTime = performance.now();
let velocity = 0;

function trackVelocity() {
  const now = performance.now();
  const dt = now - lastTime;
  const dy = window.scrollY - lastScrollY;
  velocity += (dy / dt - velocity) * 0.15; // lerp
  lastScrollY = window.scrollY;
  lastTime = now;
}

// Apply to elements via GSAP quickTo for 60fps
const compressImages = gsap.quickTo('.grid-image', 'scaleY', { duration: 0.3 });
const compressHeadlines = gsap.quickTo('.headline', 'letterSpacing', { duration: 0.3 });
// Update each frame: compressImages(1 - Math.min(velocity, 3) * 0.01);
```

### Transition
Velocity-aware crossfade: fast scroll triggers sharper, shorter transition (200ms); slow scroll uses gentler 600ms fade.

### Mobile Strategy
- Disable velocity effects below 768px (touch scroll lacks velocity resolution)
- Use scroll-direction detection only (add class .scrolling-up/.scrolling-down)
- Direction classes drive simple CSS transitions (translateY shifts, opacity changes)
- Cap max compression at 50% of desktop values to prevent layout breakage

### Performance Budget
- Velocity computation: must complete in < 0.5ms per frame
- Max 30 elements receiving velocity updates simultaneously
- Use gsap.quickTo() for all velocity-driven properties (batch property writes)
- No layout reads inside velocity update loop

### When NOT to Use
- Content-heavy reference pages (velocity effects distract from reading)
- Forms or interactive input sections
- Pages with frequent scroll position jumps (anchor links, SPA navigation)

---

## 4. Sticky Narrative

### Use Case
Sticky sidebar + scrolling content. Narrative follows reader through long content. Best for: long-form journalism, case studies, tutorials.

### Depth Configuration
```
Layer 0 (0.05x): Page background — static
Layer 1 (0.20x): Sticky narrative sidebar — pinned text track
Layer 2 (0.50x): Scrolling evidence/images — parallax at half speed
Layer 3 (1.00x): Inline body content — scrolls at native speed
Layer 4 (1.10x): Pull quotes — subtle translateY parallax as they enter viewport
```

### Scroll Behavior
- Sidebar pin: position: sticky; top: 10vh; height: 80vh
- Narrative text updates: swap text content at section boundaries (IntersectionObserver with threshold: 0.5)
- Text swap transition: opacity crossfade 300ms, no movement
- Scrolling images: translateY at 0.4x scroll rate relative to container
- Section boundaries: content sections at min 120vh each to ensure readable pacing
- Active section indicator: thin vertical line (2px) in sidebar fills proportionally to scroll progress
- Pull quotes: scale(0.96) to scale(1.0) + opacity over first 30% of their scroll through viewport

### Transition
Sidebar unpins naturally at end of content. No artificial transition needed — content simply continues.

### Mobile Strategy
- Below 768px: stack layout — sidebar becomes header above each section
- Sticky behavior disabled entirely; content flows vertically
- Section headers (previously sidebar text) appear as h2 elements with 80vh min-height per section
- Image parallax disabled; images become static within flow

### Performance Budget
- IntersectionObserver threshold precision: 0.5 (avoid rapid-fire callbacks)
- Text content swaps: pre-render all narrative states, toggle visibility (no DOM creation)
- Max 6 sidebar text states per page
- Image parallax: will-change applied only when image is within 200px of viewport

### When NOT to Use
- Short content (<2000px total height — sticky feels gratuitous)
- Content requiring non-linear reading (reference docs, wikis)
- Pages where the sidebar needs to be interactive (forms, filters)

---

## 5. Chaptered Release

### Use Case
Shopify Editions-style. Multiple pinned chapters, each with distinct visual world. Best for: product releases, feature announcements, campaign reveals.

### Depth Configuration
```
Layer 0 (0.10x): Chapter background color/gradient — morphs between chapters
Layer 1 (0.25x): Ambient pattern / noise texture — subtle drift
Layer 2 (0.50x): Chapter illustration / hero image — enter with parallax
Layer 3 (0.80x): Feature cards / text blocks — staggered entrance
Layer 4 (1.00x): Chapter title — pinned during chapter active phase
Layer 5 (1.15x): Navigation dots / progress — fixed overlay
```

### Scroll Behavior
- Chapters: 5-8 chapters, each 200-300vh pinned duration
- Chapter title: position fixed during active chapter, fades out in last 15% of chapter
- Background color morph: GSAP tween between hex values tied to scroll progress (scrub: true)
- Feature cards: staggered translateY(80px) + opacity entrance, 120ms stagger between cards
- Chapter transition: outgoing chapter fades to 0 opacity + scale(0.97) while incoming chapter fades in + scale(1.0), 15% overlap between chapters
- Progress dots: fill state updates at chapter boundaries, CSS transition 300ms

### Transition
Cross-fade morph between chapters. Outgoing chapter holds at opacity 0.3 until incoming reaches 0.7, then completes fade. Prevents blank-screen flash.

### Mobile Strategy
- Below 768px: reduce to 3 chapters max (most important only)
- Pin duration reduced to 100-150vh per chapter
- Disable background color morphing; use hard cuts between chapter colors
- Feature cards: stack vertically, no stagger animation
- Reduce depth layers to 3 (background, content, title)

### Performance Budget
- Max 6 compositor layers per chapter (clean up outgoing chapter layers)
- Background color morph: use CSS custom properties + transition, not JS tweening on mobile
- Chapter cleanup: remove will-change from all outgoing chapter elements immediately on exit
- Navigation dots: CSS-only (no JS updates during scroll)

### When NOT to Use
- Content where users need to compare across chapters (forces sequential viewing)
- SEO-critical pages (pinned content is below the fold, crawlers may miss early content)
- Pages with expected return visits (repeat users hate re-watching pinned sequences)

---

## 6. Parallax Gallery

### Use Case
Image grid with multi-depth parallax. Each image at different depth. Best for: portfolios, lookbooks, editorial spreads.

### Depth Configuration
```
Layer 0 (0.05x): Page background color — static
Layer 1 (0.15x): Grid container border/decoration — barely moves
Layer 2 (0.25x): Large featured images (spans 2 columns) — slow drift
Layer 3 (0.45x): Medium portrait images — medium drift
Layer 4 (0.65x): Small detail images — noticeable drift
Layer 5 (0.85x): Text captions — drift slightly
Layer 6 (1.00x): Hover overlays / interaction layer — native scroll
Layer 7 (1.10x): Cursor-following label — fixed position, scroll-independent
```

### Scroll Behavior
- Grid: CSS Grid or Masonry layout, 3-4 columns desktop, 2 columns tablet
- Each image: data-speed attribute (0.25 to 0.85) drives translateY rate
- Parallax formula: translateY = scrollY * (1 - speed) * -1
- Column offset: even columns start 80px lower than odd columns for visual rhythm
- Image reveal: clip-path inset reveal from bottom as each image enters viewport
  - clip-path: inset(100% 0 0 0) to inset(0 0 0 0) over 60% of image's viewport traversal
- Hover state: scale(1.02) + overlay opacity 0 to 0.3, CSS transition 400ms ease-out

### Transition
No explicit transition between galleries. Natural scroll continuation. If multiple galleries on page, use subtle section divider (128px whitespace + thin 1px line).

### Mobile Strategy
- Below 768px: 2-column grid, all images at same depth (parallax disabled)
- Image reveal: simple opacity fade instead of clip-path
- Reduce image count: show max 12 images per gallery (load more button below)
- Disable cursor-following label; show captions statically below images

### Performance Budget
- Max 20 images with active parallax simultaneously
- Use transform3d() for all parallax translations (forces GPU compositing)
- Image loading: eager for first 6, lazy for remainder
- will-change: transform applied when image is within 500px of viewport, removed when >500px past

### When NOT to Use
- Image-heavy pages on slow connections (>50 images without pagination)
- Galleries where exact image alignment matters (parallax breaks strict grids)
- Pages requiring text selection near parallax elements (visual displacement confuses selection)

---

## 7. 3D Product Orbit

### Use Case
Product rotates in 3D space driven by scroll. Best for: product pages, device launches, automotive reveals.

### Depth Configuration
```
Layer 0 (0.10x): Radial gradient background — shifts hue with scroll progress
Layer 1 (0.30x): Shadow plane — rotateX(75deg) scale changes with proximity
Layer 2 (0.60x): Product spec callouts — pins at feature positions
Layer 3 (1.00x): Product mesh/image — CSS 3D rotateY driven by scroll
Layer 4 (1.20x): Reflection/ambient occlusion — fades in at frontal angles
Layer 5 (1.40x): Hotspot labels — fixed position, appear at specific angles
```

### Scroll Behavior
- Pin duration: 300-500vh (longer pin for full 360-degree rotation)
- Product rotation: rotateY maps 0deg to 360deg across full scroll range
- Perspective: container has perspective: 1200px; product has transform-style: preserve-3d
- Shadow: scale(0.8) to scale(1.0) inversely to rotation angle (smaller when viewing edge-on)
- Spec callouts: appear at specific rotation angles (e.g., rotateY 45deg = show camera spec)
  - Callout entrance: translateZ(-100px) to translateZ(0) + opacity 0 to 1
  - Callout exit: translateZ(0) to translateZ(100px) + opacity 1 to 0
- Hotspot labels: fade in over 15deg rotation window, hold for 30deg, fade out over 15deg
- Background gradient: hue-rotate shifts subtly (10-20deg range) tied to scroll progress

### CSS 3D Implementation
```css
.orbit-container {
  perspective: 1200px;
  perspective-origin: 50% 50%;
}

.product-stage {
  transform-style: preserve-3d;
  /* rotateY applied via GSAP ScrollTrigger scrub */
}

.product-mesh {
  /* Product image rendered front + back faces */
  backface-visibility: hidden;
}
```

### Transition
RotateX tilt-back (product tilts away) + fade to next section. rotateX from 0deg to 25deg + opacity 1 to 0 over last 10% of pin.

### Mobile Strategy
- Below 768px: replace 3D rotation with swipeable carousel (touch events)
- Reduce rotation range: 180deg instead of 360deg (show front and sides only)
- Disable perspective transform; use flat translateX sliding between angles
- Disable spec callout 3D entrance; use simple fade
- Reduce depth layers to 2 (product, labels)

### Performance Budget
- Max 1 active 3D scene per page
- Product images: max 4 faces rendered (front, back, left, right), each max 800px wide
- No blur/backdrop-filter during rotation
- perspective-origin updates: batch with rotation updates (same RAF callback)

### When NOT to Use
- Products where back/side views add no value (simple/round objects)
- Pages requiring quick product comparison (forces sequential viewing)
- Low-end devices as primary audience (3D transforms are expensive)

---

## 8. Editorial Longread

### Use Case
Magazine-style long-form with inline parallax images, pull quotes with depth, and typographic reveals. Best for: brand stories, essays, thought leadership.

### Depth Configuration
```
Layer 0 (0.00x): Body text — native scroll, no parallax
Layer 1 (0.20x): Inline images — subtle parallax drift (translateY at 0.15x)
Layer 2 (0.40x): Pull quotes — moderate drift + scale entrance
Layer 3 (0.70x): Full-bleed chapter images — noticeable parallax
Layer 4 (1.00x): Sticky chapter marker — fixed position during chapter
Layer 5 (1.10x): Footnote popups — overlay, scroll-independent
```

### Scroll Behavior
- Content width: max 680px centered for body text (optimal reading measure)
- Inline images: break out to 120% container width, parallax at 0.15x rate
- Pull quotes: break to full-bleed, translateY at 0.3x rate + scale(0.98) to scale(1.0) on entrance
- Chapter images: full viewport width, parallax at 0.5x rate, min-height 80vh
- Typography: headings use character-by-character or word-by-word reveal
  - Word reveal: each word translateY(20px) opacity(0) to translateY(0) opacity(1)
  - Stagger: 30ms per word, triggered at heading top hitting 80% viewport
  - Trigger threshold: IntersectionObserver rootMargin "0px 0px -20% 0px"
- Body text paragraphs: no entrance animation (readable immediately)
- Chapter markers: thin vertical line (3px) + Roman numeral, position: sticky, opacity fade on chapter exit

### Transition
No explicit transitions between sections. Visual rhythm created by alternating text blocks, inline images, and full-bleed chapter images. Whitespace (15-25vh) between chapters provides natural breathing room.

### Mobile Strategy
- Below 768px: max content width 100% with 24px padding
- Disable inline image parallax; images scroll natively
- Pull quotes: reduce to 110% container width, no scale animation
- Word-by-word heading reveal: reduce stagger to 15ms per word (faster on small screens)
- Chapter images: reduce to 60vh min-height
- Font size: minimum 18px body text for mobile readability

### Performance Budget
- Word reveal animations: max 50 words animated simultaneously
- IntersectionObserver for text reveals: batch all heading observations in single observer
- Images: lazy load all inline and chapter images; eager load only first chapter image
- No parallax on body text (prevents subpixel text rendering issues)

### When NOT to Use
- Short-form content (<1500 words — animations feel gratuitous)
- Highly skimmable reference content (animations impede scanning)
- Pages with heavy interactivity alongside reading (conflicting focus)

---

## 9. Data Story

### Use Case
Scroll-driven data visualization. Charts build as you scroll. Best for: annual reports, impact pages, research presentations.

### Depth Configuration
```
Layer 0 (0.05x): Page background — subtle grid pattern
Layer 1 (0.20x): Chart axes and gridlines — static after reveal
Layer 2 (0.50x): Data bars / line path — scroll-drawn entrance
Layer 3 (0.80x): Data labels and annotations — fade in after data
Layer 4 (1.00x): Key statistic callouts — pinned during highlight
Layer 5 (1.15x): Source citations — bottom layer, no parallax
```

### Scroll Behavior
- Chart reveal: SVG paths use stroke-dashoffset animation tied to scroll progress
- Bar charts: bars scaleY from 0 to 1 (transform-origin: bottom) over scroll range
  - Stagger: 80ms between bars within same chart
  - Easing: power2.out for natural acceleration feel
- Line charts: path draws left-to-right, stroke-dashoffset from totalLength to 0
- Data labels: fade in (opacity 0 to 1, translateY 10px to 0) after their data element reaches 80% of final value
- Key statistics: large numbers count up from 0 to final value over scroll range
  - Number animation: requestAnimationFrame with eased interpolation
  - Format: use Intl.NumberFormat for locale-aware formatting
  - Trigger: statistic element enters 70% viewport height
- Annotations: appear at specific scroll positions with leader lines connecting to data points

### Scroll-Scrubbed Chart Implementation
```
// GSAP ScrollTrigger + DrawSVG-style approach
ScrollTrigger.create({
  trigger: ".chart-container",
  start: "top 80%",
  end: "bottom 20%",
  scrub: 0.8,
  onUpdate: (self) => {
    const progress = self.progress;
    // Update chart progress
    gsap.set('.chart-path', { strokeDashoffset: totalLength * (1 - progress) });
    gsap.set('.chart-bar', { scaleY: progress, stagger: 0.02 });
  }
});
```

### Transition
Chart-to-chart: outgoing chart fades to 0.2 opacity + reduces to scale(0.95) while incoming chart at full scale fades in. 200px overlap zone between charts.

### Mobile Strategy
- Below 768px: convert complex charts to simplified versions
- Multi-series line charts: show one series at a time with toggle buttons
- Bar charts: reduce max bars to 8 (aggregate smaller values into "other")
- Disable scroll-scrubbed number counting; show final values immediately
- Touch: add horizontal swipe between chart tabs if needed

### Performance Budget
- Max 1 actively-animating chart per viewport
- SVG path length: pre-compute getTotalLength() on mount, cache values
- Number counter: update max 10 statistics simultaneously
- Chart animations: use CSS transitions where possible (less JS overhead than RAF)
- will-change: transform on bars/lines during their active scroll window only

### When NOT to Use
- Real-time dashboards (scroll metaphor conflicts with live data)
- Pages where precise data comparison is primary goal (animations slow down comparison)
- Data with >50 points per series (aggregate or use static chart instead)

---

## 10. Landing Sequence

### Use Case
Rapid-fire sequence of full-viewport scenes, each 100-150vh. Best for: event pages, campaign microsites, splash experiences.

### Depth Configuration
```
Layer 0 (0.00x): Scene background — full-bleed image/video, pinned
Layer 1 (0.20x): Atmospheric particles / overlay texture — subtle drift
Layer 2 (0.50x): Scene headline — large typography, parallax at 0.4x
Layer 3 (0.80x): Scene subtext / CTA — moderate parallax
Layer 4 (1.00x): Foreground element — sharp, native scroll
Layer 5 (1.20x): Fixed navigation / scene indicator — overlay, always visible
```

### Scroll Behavior
- Scenes: 4-6 scenes, each 100-150vh
- Scene transition: "wipe" effect — outgoing scene translates up at 1.0x while incoming at 0.7x (parallax difference creates depth)
- Headline: character split animation, each character translateY(100%) to 0 with 25ms stagger
  - Trigger: scene enters 60% of viewport
  - Duration: proportional to character count (max 800ms total)
- Background: subtle scale(1.05) to scale(1.0) over scene duration (Ken Burns effect)
- CTA buttons: opacity fade in after headline completes, translateY(20px) to 0
- Scene indicator: dots or progress bar at bottom/top of viewport, updates at scene boundaries
- Snap: ScrollTrigger snap to scene centers on scroll release (mandatory — no in-between states)

### Snap Configuration
```
ScrollTrigger.create({
  snap: {
    snapTo: (progress) => {
      // Snap to nearest scene center
      const sceneCount = 5;
      const sceneProgress = 1 / sceneCount;
      const targetScene = Math.round(progress / sceneProgress);
      return targetScene * sceneProgress;
    },
    duration: { min: 0.2, max: 0.5 },
    delay: 0,
    ease: "power2.out"
  }
});
```

### Transition
Wipe-up transition between scenes. Outgoing scene: translateY(0) to translateY(-30vh). Incoming: translateY(30vh) to translateY(0). Both active simultaneously during overlap zone (last 20vh of outgoing + first 20vh of incoming).

### Mobile Strategy
- Below 768px: reduce to 3 scenes max
- Scene height: 80vh instead of 100-150vh (less scrolling fatigue)
- Disable character split animation; use word-level fade instead
- Ken Burns background: disable scale animation (static background)
- Snap: increase snap duration to 0.4s min (smoother on touch)
- Auto-advance: optional 8s timer with pause on interaction

### Performance Budget
- Max 2 scenes in DOM simultaneously (incoming + outgoing)
- Lazy-load scene backgrounds: load N+1 scene background when scene N is active
- Video backgrounds: load only for first scene; poster image for others until active
- Scene indicator: CSS-only, no JS updates

### When NOT to Use
- Informational pages (forces linear consumption)
- Return-visit heavy pages (users skip scenes on repeat visits — provide "skip" button)
- Pages with external links as primary goal (sequence delays user reaching CTA)

---

## 11. Portfolio Reveal

### Use Case
Work samples revealed through scroll with depth layering. Case studies unfold as user scrolls. Best for: agency portfolios, personal sites, creative showcases.

### Depth Configuration
```
Layer 0 (0.05x): Page background — subtle color shift between projects
Layer 1 (0.15x): Project thumbnail grid — slow parallax
Layer 2 (0.35x): Project title — moderate parallax + mask reveal
Layer 3 (0.60x): Project hero image — main visual element
Layer 4 (0.85x): Tags, metadata, awards — drift with scroll
Layer 5 (1.00x): Project description text — native scroll
Layer 6 (1.20x): "View Project" CTA — fixed during project active phase
Layer 7 (1.30x): Navigation arrows — always visible overlay
```

### Scroll Behavior
- Projects: each project = one chapter, 200-300vh per project
- Project entrance: hero image slides in from right (translateX 100px to 0) + opacity 0 to 1 over first 30% of project scroll
- Title: clip-path polygon reveal from left to right, triggered as hero reaches 50% visibility
- Thumbnail grid: images stagger in with 100ms delay, each translateY(40px) + opacity 0 to 1
- Metadata: fade in after title reveal completes (sequential, not simultaneous)
- Color shift: background color interpolates between project brand colors over 50vh at project boundary
- CTA: position fixed during project, fades out in last 15% of project scroll
- Project transition: outgoing project fades + translates up (-50px) while incoming enters from below

### Transition
Overlapping fade with vertical offset. Outgoing project: translateY(0) opacity(1) to translateY(-50px) opacity(0). Incoming: translateY(50px) opacity(0) to translateY(0) opacity(1). 80vh overlap zone.

### Mobile Strategy
- Below 768px: stack layout, no pinning per project
- Project height: auto (content-driven), min 100vh per project
- Hero image: full-width, no slide-in animation
- Thumbnail grid: 2 columns, no stagger animation
- Color shift: hard cut instead of interpolation
- CTA: appears inline at end of project, not fixed

### Performance Budget
- Max 3 project hero images loaded initially; lazy load remainder
- Thumbnail images: 400px max width, WebP format
- Color interpolation: use CSS custom properties + transition, not JS on mobile
- will-change: transform on max 4 elements per project

### When NOT to Use
- Portfolio with >15 projects (break into categories or use archive pattern instead)
- Cases where side-by-side project comparison is needed
- Recruitment-focused pages where quick scan of skills matters most

---

## 12. Archive Explorer

### Use Case
Horizontal scroll + vertical navigation for browsing large collections. Best for: museums, libraries, brand archives, photo collections.

### Depth Configuration
```
Layer 0 (0.00x): Vertical navigation sidebar — fixed position
Layer 1 (0.10x): Background texture/pattern — static
Layer 2 (0.30x): Archive item cards — subtle translateZ on hover
Layer 3 (0.60x): Card images — parallax within card on horizontal scroll
Layer 4 (1.00x): Card titles and metadata — native with horizontal scroll
Layer 5 (1.20x): Detail panel overlay — fixed, appears on selection
Layer 6 (1.30x): Scroll progress indicator — fixed top overlay
```

### Scroll Behavior
- Vertical page scroll maps to horizontal content translation
- Container: overflow: hidden; content width = itemCount * itemWidth + gaps
- Scroll ratio: 1px vertical scroll = 1px horizontal translation (1:1 feels most natural)
- CSS scroll-snap: mandatory snap to item centers
  - scroll-snap-type: x mandatory (on the horizontal track)
  - scroll-snap-align: center (on each item)
- Items: fixed width (300-400px desktop, 260px mobile), consistent height (70vh)
- Card image parallax: within each card, image translateX shifts at 0.8x rate of container scroll (subtle depth within card)
- Navigation sidebar: decade/category links, click scrolls to target position
- Progress bar: scaleX maps to scroll progress across full archive
- Detail panel: click item to open overlay with full metadata, opacity + translateX(50px) entrance

### Horizontal Scroll Implementation
```
// GSAP ScrollTrigger for vertical-to-horizontal
gsap.to('.archive-track', {
  x: () => -(track.scrollWidth - container.offsetWidth),
  ease: 'none',
  scrollTrigger: {
    trigger: '.archive-container',
    pin: true,
    scrub: 0.5,
    end: () => '+=' + (track.scrollWidth - container.offsetWidth)
  }
});
```

### Transition
Entering archive: fade from previous section into pinned horizontal container over 40vh vertical scroll. Exiting: horizontal track completes, container unpins, normal vertical scroll resumes.

### Mobile Strategy
- Below 768px: switch to vertical card stack (horizontal scroll is awkward on touch)
- Cards: full-width, 85vh height each
- Scroll-snap: y mandatory instead of x
- Navigation: horizontal scrollable tab bar at top instead of sidebar
- Card image parallax: disable (simplifies touch interaction)
- Detail panel: slide-up bottom sheet instead of overlay

### Performance Budget
- Max 30 cards rendered in DOM simultaneously (virtualize for larger archives)
- Card images: 600px max width, lazy loaded with 300px placeholder blur
- ScrollTrigger scrub: 0.5 for smooth feel without excessive JS calls
- Virtualization: recycle DOM nodes for archives >50 items (remove off-screen cards)

### When NOT to Use
- Small collections (<10 items — horizontal scroll is overkill)
- Search-result pages (users expect vertical scan, not horizontal)
- Pages where item order is not significant (random browsing is better as a grid)
