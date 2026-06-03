import type { ScrollMorphTheme } from 'choreo-3d';

export type EditionChapter = {
  id: string;
  roman: string;
  eyebrow: string;
  title: string;
  summary: string;
  technicalDetail: string;
  features: string[];
  accent: string;
  /**
   * Optional. When undefined, ChapterScene renders the CSS-only ChapterDemoVisual
   * (works beautifully without any fal.ai setup). Set to a path like
   * `/generated/<id>.jpg` after running `node scripts/generate-chapter-assets.mjs`.
   */
  background?: string;
  /** Optional inline base64/blur data URL — enables Next/Image blur placeholder. */
  backgroundBlur?: string;
  foreground?: string;
  poster?: string;
  video?: string;
  /** Background-morph atmosphere for this chapter. */
  atmosphere: ScrollMorphTheme;
  visualPrompt: {
    subject: string;
    productTruth: string;
    historicalLayer: 'renaissance' | 'baroque' | 'atelier' | 'architectural' | 'industrial';
    modernLayer: string;
    palette: string[];
    camera: 'wide' | 'medium' | 'macro' | 'isometric' | 'low-angle';
  };
};

/**
 * 8-chapter demo manifest. Replace with project-specific chapters.
 * 6–12 chapters is the sweet spot — under 6 feels light, over 12 feels endless.
 */
export const editionChapters: EditionChapter[] = [
  {
    id: 'prologue',
    roman: 'I',
    eyebrow: 'The Release',
    title: 'A new operating layer for visual decisions.',
    summary:
      'A cinematic chaptered page that turns product updates into a world people understand in seconds.',
    technicalDetail:
      'Scroll progress drives 7 pinned layers per chapter, atmospheric background morphs, and generated visual assets.',
    features: ['Chapter taxonomy', 'Generated visual system', 'HTML overlay typography'],
    accent: '#ff4fc3',
    // background: '/generated/prologue.webp',   ← uncomment after running `node scripts/generate-chapter-assets.mjs`
    foreground: '/generated/prologue-figure.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #0b0907 0%, #1a1410 60%, #2a1a14 100%)',
    },
    visualPrompt: {
      subject: 'two figures in a classical studio discovering a glowing product interface on a table',
      productTruth: 'the product turns fragmented updates into a coherent release system',
      historicalLayer: 'renaissance',
      modernLayer: 'transparent software panel, product cards, subtle AI terminal glow',
      palette: ['aged cream', 'deep umber', 'acid pink', 'soft sky blue'],
      camera: 'wide',
    },
  },
  {
    id: 'agentic',
    roman: 'II',
    eyebrow: 'Agentic Layer',
    title: 'The interface stops waiting for instructions.',
    summary: 'Agents convert product context into suggested actions, experiments, and operational next steps.',
    technicalDetail: 'Fast foreground UI layer over a slow generated background keeps content editable.',
    features: ['Action routing', 'Context memory', 'Approval gates'],
    accent: '#b4ff38',
    // background: '/generated/agentic.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom right, #0d1410 0%, #14201a 60%, #1f2e1c 100%)',
    },
    visualPrompt: {
      subject: 'a classical cartographer mapping commerce routes that become glowing conversational pathways',
      productTruth: 'agents expose product actions across chat, search, and workflow surfaces',
      historicalLayer: 'baroque',
      modernLayer: 'floating graph nodes, chat cards, route lines, product tiles',
      palette: ['dark olive', 'gold leaf', 'blackened green', 'electric lime'],
      camera: 'medium',
    },
  },
  {
    id: 'studio',
    roman: 'III',
    eyebrow: 'Visual Studio',
    title: 'Assets become a pipeline, not a folder.',
    summary: 'fal.ai generates chapter images, posters, and variants through a structured prompt contract.',
    technicalDetail: 'Server-side generation protects credentials, normalises prompts, and records output metadata.',
    features: ['fal.ai proxy', 'Prompt manifest', 'Variant generation'],
    accent: '#37c7ff',
    // background: '/generated/studio.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #0a1418 0%, #102230 60%, #1a3447 100%)',
    },
    visualPrompt: {
      subject: 'a painterly atelier where canvases connect to a modern asset generation console',
      productTruth: 'creative direction becomes repeatable infrastructure',
      historicalLayer: 'atelier',
      modernLayer: 'generation queue, image grid, prompt cards, render status lights',
      palette: ['warm canvas', 'sepia', 'cyan', 'bone white'],
      camera: 'wide',
    },
  },
  {
    id: 'taste',
    roman: 'IV',
    eyebrow: 'Taste Layer',
    title: 'Quality becomes a scoring function.',
    summary: 'Every generated asset passes a measurable taste filter before reaching the page.',
    technicalDetail: 'Evaluation runs as a pure function on prompt + output metadata; scores feed back into ranking.',
    features: ['Composition scoring', 'Palette adherence', 'Brand voice gate'],
    accent: '#e87e7e',
    // background: '/generated/taste.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #1a0f10 0%, #2a181a 60%, #3a2024 100%)',
    },
    visualPrompt: {
      subject: 'a renaissance textile master inspecting silk samples under structured studio light',
      productTruth: 'taste is enforced as a deterministic, measurable layer',
      historicalLayer: 'renaissance',
      modernLayer: 'score readouts, composition overlays, accept/reject toggles',
      palette: ['deep crimson', 'ivory', 'oxidised brass', 'soft rose'],
      camera: 'macro',
    },
  },
  {
    id: 'infrastructure',
    roman: 'V',
    eyebrow: 'Infrastructure',
    title: 'The mesh that holds the worlds together.',
    summary: 'Edge runtime, queue workers, and private networking that keep generation fast and durable.',
    technicalDetail: 'Vercel Edge + queue workers + Tailscale mesh. Background jobs use fal.queue webhook callbacks.',
    features: ['Edge runtime', 'Durable queues', 'Mesh networking'],
    accent: '#c8a0f0',
    // background: '/generated/infrastructure.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #100b1a 0%, #1a142a 60%, #28203f 100%)',
    },
    visualPrompt: {
      subject: 'a victorian engine room reimagined as a soft, glowing distributed computing diagram',
      productTruth: 'the platform survives spikes and stays cheap at idle',
      historicalLayer: 'industrial',
      modernLayer: 'queue depth gauges, edge region map, latency sparklines',
      palette: ['twilight purple', 'brass', 'steel blue', 'ember orange'],
      camera: 'wide',
    },
  },
  {
    id: 'deploy',
    roman: 'VI',
    eyebrow: 'Deploy Layer',
    title: 'Every release is a reversible plan.',
    summary: 'DAG-based deploys make each step inspectable, pausable, and revertable.',
    technicalDetail: 'Plans compile to a DAG; agents execute steps with explicit approval gates between layers.',
    features: ['DAG planner', 'Approval gates', 'One-click rollback'],
    accent: '#f0c060',
    // background: '/generated/deploy.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #1a1308 0%, #2a1f10 60%, #3a2d18 100%)',
    },
    visualPrompt: {
      subject: 'an architectural drafting studio where blueprints flow into a glowing release plan',
      productTruth: 'deployments stop being terrifying',
      historicalLayer: 'architectural',
      modernLayer: 'plan tiles, approval buttons, rollback timeline',
      palette: ['vellum', 'india ink', 'amber', 'bone'],
      camera: 'isometric',
    },
  },
  {
    id: 'integration',
    roman: 'VII',
    eyebrow: 'Integration Surface',
    title: 'Plug into anything you already use.',
    summary: 'FastMCP tools, REST connectors, and webhooks make the platform a citizen of your stack.',
    technicalDetail: 'Adapters expose the same primitives to MCP, REST, and event sources without per-target rewrites.',
    features: ['MCP server', 'REST connectors', 'Webhook gateway'],
    accent: '#60d0e0',
    // background: '/generated/integration.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #08161a 0%, #102830 60%, #1a3a47 100%)',
    },
    visualPrompt: {
      subject: 'a telegraph exchange where copper wires resolve into a clean modern integration diagram',
      productTruth: 'integration becomes a configuration, not a project',
      historicalLayer: 'industrial',
      modernLayer: 'tool registry, connector cards, webhook log',
      palette: ['midnight teal', 'copper', 'sky', 'graphite'],
      camera: 'medium',
    },
  },
  {
    id: 'horizon',
    roman: 'VIII',
    eyebrow: 'The Horizon',
    title: 'Compounding advantage, one chapter at a time.',
    summary: 'Each release adds a permanent capability — the platform learns the way an atelier learns.',
    technicalDetail: 'A capability graph captures what the platform can do; agents query it to plan future work.',
    features: ['Capability graph', 'Learned templates', 'Open roadmap'],
    accent: '#e8e0c8',
    // background: '/generated/horizon.webp',
    atmosphere: {
      background: 'linear-gradient(to bottom, #14110a 0%, #1f1b12 60%, #2e2820 100%)',
    },
    visualPrompt: {
      subject: 'a cliff surveyor at dawn measuring a wide unfolding landscape',
      productTruth: 'the system gets better every release without changing what it is',
      historicalLayer: 'atelier',
      modernLayer: 'roadmap card, capability map, version timeline',
      palette: ['parchment', 'rust', 'sky', 'ink'],
      camera: 'wide',
    },
  },
];

/** Theme map keyed by chapter id, ready to pass to <ScrollBackgroundMorph themes={...}>. */
export const editionThemes: Record<string, ScrollMorphTheme> = Object.fromEntries(
  editionChapters.map((chapter) => [chapter.id, chapter.atmosphere]),
);
