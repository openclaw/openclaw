import { svg, type TemplateResult } from "lit";

// Lucide-style SVG icons used throughout the config builder.
// Ported from the OpenClaw web UI icon set + additions.

function icon(content: TemplateResult): TemplateResult {
  return svg`<svg
    class="cb-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${content}
  </svg>`;
}

// --- Section icons (match web UI sidebar) ---

export const iconGateway = icon(svg`
  <circle cx="12" cy="12" r="10"></circle>
  <line x1="2" y1="12" x2="22" y2="12"></line>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
`);

export const iconChannels = icon(svg`
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
`);

export const iconAgents = icon(svg`
  <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path>
  <circle cx="8" cy="14" r="1"></circle>
  <circle cx="16" cy="14" r="1"></circle>
`);

export const iconAuth = icon(svg`
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
`);

export const iconMessages = icon(svg`
  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
  <polyline points="22,6 12,13 2,6"></polyline>
`);

export const iconTools = icon(svg`
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
`);

export const iconSession = icon(svg`
  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
  <circle cx="9" cy="7" r="4"></circle>
  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
`);

export const iconHooks = icon(svg`
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
`);

export const iconSkills = icon(svg`
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
`);

export const iconCommands = icon(svg`
  <polyline points="4 17 10 11 4 5"></polyline>
  <line x1="12" y1="19" x2="20" y2="19"></line>
`);

export const iconModels = icon(svg`
  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
  <line x1="12" y1="22.08" x2="12" y2="12"></line>
`);

export const iconEnv = icon(svg`
  <circle cx="12" cy="12" r="3"></circle>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
`);

export const iconUpdate = icon(svg`
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
  <polyline points="7 10 12 15 17 10"></polyline>
  <line x1="12" y1="15" x2="12" y2="3"></line>
`);

export const iconLogging = icon(svg`
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
  <polyline points="14 2 14 8 20 8"></polyline>
  <line x1="16" y1="13" x2="8" y2="13"></line>
  <line x1="16" y1="17" x2="8" y2="17"></line>
`);

export const iconBroadcast = icon(svg`
  <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
  <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
  <circle cx="12" cy="12" r="2"></circle>
  <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
  <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
`);

export const iconPlugins = icon(svg`
  <path d="M12 2v6"></path>
  <path d="m4.93 10.93 4.24 4.24"></path>
  <path d="M2 12h6"></path>
  <path d="m4.93 13.07 4.24-4.24"></path>
  <path d="M12 22v-6"></path>
  <path d="m19.07 13.07-4.24-4.24"></path>
  <path d="M22 12h-6"></path>
  <path d="m19.07 10.93-4.24 4.24"></path>
`);

export const iconWeb = icon(svg`
  <circle cx="12" cy="12" r="10"></circle>
  <line x1="2" y1="12" x2="22" y2="12"></line>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
`);

export const iconCron = icon(svg`
  <circle cx="12" cy="12" r="10"></circle>
  <polyline points="12 6 12 12 16 14"></polyline>
`);

export const iconAudio = icon(svg`
  <path d="M9 18V5l12-2v13"></path>
  <circle cx="6" cy="18" r="3"></circle>
  <circle cx="18" cy="16" r="3"></circle>
`);

export const iconUI = icon(svg`
  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
  <line x1="3" y1="9" x2="21" y2="9"></line>
  <line x1="9" y1="21" x2="9" y2="9"></line>
`);

export const iconWizard = icon(svg`
  <path d="M15 4V2"></path>
  <path d="M15 16v-2"></path>
  <path d="M8 9h2"></path>
  <path d="M20 9h2"></path>
  <path d="M17.8 11.8 19 13"></path>
  <path d="M15 9h0"></path>
  <path d="M17.8 6.2 19 5"></path>
  <path d="m3 21 9-9"></path>
  <path d="M12.2 6.2 11 5"></path>
`);

export const iconDefault = icon(svg`
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
  <polyline points="14 2 14 8 20 8"></polyline>
`);

// --- UI action icons ---

export const iconSearch = icon(svg`
  <circle cx="11" cy="11" r="8"></circle>
  <path d="M21 21l-4.35-4.35"></path>
`);

export const iconChevronDown = icon(svg`
  <polyline points="6 9 12 15 18 9"></polyline>
`);

export const iconChevronRight = icon(svg`
  <polyline points="9 18 15 12 9 6"></polyline>
`);

export const iconChevronLeft = icon(svg`
  <polyline points="15 18 9 12 15 6"></polyline>
`);

export const iconCopy = icon(svg`
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
`);

export const iconDownload = icon(svg`
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
  <polyline points="7 10 12 15 17 10"></polyline>
  <line x1="12" y1="15" x2="12" y2="3"></line>
`);

export const iconTrash = icon(svg`
  <polyline points="3 6 5 6 21 6"></polyline>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
`);

export const iconCheck = icon(svg`
  <polyline points="20 6 9 17 4 12"></polyline>
`);

export const iconX = icon(svg`
  <line x1="18" y1="6" x2="6" y2="18"></line>
  <line x1="6" y1="6" x2="18" y2="18"></line>
`);

export const iconSparkles = icon(svg`
  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path>
  <path d="M5 3v4"></path>
  <path d="M19 17v4"></path>
  <path d="M3 5h4"></path>
  <path d="M17 19h4"></path>
`);

export const iconImport = icon(svg`
  <path d="M12 3v12"></path>
  <path d="m8 11 4 4 4-4"></path>
  <path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"></path>
`);

export const iconExternalLink = icon(svg`
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
  <polyline points="15 3 21 3 21 9"></polyline>
  <line x1="10" y1="14" x2="21" y2="3"></line>
`);

export const iconEye = icon(svg`
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
  <circle cx="12" cy="12" r="3"></circle>
`);

export const iconEyeOff = icon(svg`
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
  <line x1="1" y1="1" x2="23" y2="23"></line>
  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
`);

export const iconGrid = icon(svg`
  <rect x="3" y="3" width="7" height="7"></rect>
  <rect x="14" y="3" width="7" height="7"></rect>
  <rect x="14" y="14" width="7" height="7"></rect>
  <rect x="3" y="14" width="7" height="7"></rect>
`);

export const iconLock = icon(svg`
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
`);

export const iconShield = icon(svg`
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
`);

export const iconCode = icon(svg`
  <polyline points="16 18 22 12 16 6"></polyline>
  <polyline points="8 6 2 12 8 18"></polyline>
`);

export const iconSun = icon(svg`
  <circle cx="12" cy="12" r="5"></circle>
  <line x1="12" y1="1" x2="12" y2="3"></line>
  <line x1="12" y1="21" x2="12" y2="23"></line>
  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
  <line x1="1" y1="12" x2="3" y2="12"></line>
  <line x1="21" y1="12" x2="23" y2="12"></line>
  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
`);

export const iconMoon = icon(svg`
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
`);

export const iconArrowRight = icon(svg`
  <line x1="5" y1="12" x2="19" y2="12"></line>
  <polyline points="12 5 19 12 12 19"></polyline>
`);

export const iconArrowLeft = icon(svg`
  <line x1="19" y1="12" x2="5" y2="12"></line>
  <polyline points="12 19 5 12 12 5"></polyline>
`);

export const iconMoreVertical = icon(svg`
  <circle cx="12" cy="12" r="1"></circle>
  <circle cx="12" cy="5" r="1"></circle>
  <circle cx="12" cy="19" r="1"></circle>
`);

export const iconFile = icon(svg`
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
  <polyline points="14 2 14 8 20 8"></polyline>
`);

export const iconPanelRight = icon(svg`
  <rect x="3" y="3" width="18" height="18" rx="2"></rect>
  <line x1="15" y1="3" x2="15" y2="21"></line>
`);

export const iconSidebar = icon(svg`
  <rect x="3" y="3" width="18" height="18" rx="2"></rect>
  <line x1="9" y1="3" x2="9" y2="21"></line>
`);

// --- Section icon lookup ---

const SECTION_ICON_MAP: Record<string, TemplateResult> = {
  gateway: iconGateway,
  channels: iconChannels,
  agents: iconAgents,
  auth: iconAuth,
  messages: iconMessages,
  tools: iconTools,
  session: iconSession,
  hooks: iconHooks,
  skills: iconSkills,
  commands: iconCommands,
  models: iconModels,
  env: iconEnv,
  update: iconUpdate,
  logging: iconLogging,
  broadcast: iconBroadcast,
  plugins: iconPlugins,
  web: iconWeb,
  cron: iconCron,
  audio: iconAudio,
  ui: iconUI,
  wizard: iconWizard,
};

export function sectionIcon(sectionId: string): TemplateResult {
  return SECTION_ICON_MAP[sectionId] ?? iconDefault;
}
