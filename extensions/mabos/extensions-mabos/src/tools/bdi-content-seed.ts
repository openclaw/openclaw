#!/usr/bin/env ts-node
/**
 * BDI Content Seed Script
 * Populates all 17 VividWalls agent BDI markdown files with rich domain-specific content.
 * Run: ts-node bdi-content-seed.ts [workspaceDir]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE = process.argv[2] || path.join(process.env.HOME || "~", ".openclaw/workspace");
const BIZ_DIR = path.join(WORKSPACE, "businesses/vividwalls");
const AGENTS_DIR = path.join(BIZ_DIR, "agents");
const TEMPLATES_DIR = path.resolve(__dirname, "../../templates/base");

const CORE_AGENTS = [
  "ceo",
  "cfo",
  "coo",
  "cmo",
  "cto",
  "hr",
  "legal",
  "strategy",
  "knowledge",
] as const;
const DOMAIN_AGENTS = [
  "inventory-mgr",
  "fulfillment-mgr",
  "product-mgr",
  "marketing-director",
  "sales-director",
  "compliance-director",
  "creative-director",
  "cs-director",
] as const;
const ALL_AGENTS = [...CORE_AGENTS, ...DOMAIN_AGENTS];

type AgentId = (typeof ALL_AGENTS)[number];

// ── Helpers ──

function writeFile(agentId: string, filename: string, content: string) {
  const dir = path.join(AGENTS_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

function readTemplate(role: string): string {
  const p = path.join(TEMPLATES_DIR, `desires-${role}.md`);
  if (fs.existsSync(p))
    return fs.readFileSync(p, "utf-8").replace(/\{business_name\}/g, "VividWalls");
  return "";
}

let errorCount = 0;
let fileCount = 0;

// ── Beliefs Content ──

const beliefs: Record<AgentId, string> = {
  ceo: `# Beliefs — CEO

## Business Context
- **Company:** VividWalls — Premium AI-generated wall art e-commerce
- **Stage:** Early growth (launched Feb 2026)
- **Business Model:** Direct-to-consumer art prints, canvases, and custom wall art
- **Revenue Target:** $30K+/month from $2K marketing spend

## Current State
- **Team:** 17 AI agents organized in C-suite + department structure
- **Automation Level:** Targeting 95% for routine tasks
- **Key Metric:** 3.5%+ conversion rate on art sales
- **Customer Satisfaction:** Targeting 90%+ CSAT

## Market Assumptions
- Premium wall art market is growing 12-15% annually
- AI-generated art acceptance increasing among millennials and Gen-Z
- Direct-to-consumer model avoids gallery markup (60-70% savings to customer)
- Social media (Instagram, Pinterest) primary discovery channels

## Competitive Landscape
- Traditional competitors: Society6, Redbubble, Minted (mass-market)
- AI competitors: Emerging but fragmented, no dominant player
- VividWalls differentiator: Curated AI art with premium quality printing

## Constraints
- Marketing spend capped at $2K/month without stakeholder approval
- Must maintain GDPR/CCPA compliance
- All customer data handled per privacy regulations
- Sales personas must be ethical and non-manipulative
- Automation includes human oversight for critical decisions

## Stakeholder Expectations
- 13 sales personas deployed for targeted conversion
- $15M ARR by Year 2
- 15% premium wall art market capture in 24 months
`,

  cfo: `# Beliefs — CFO

## Financial Context
- **Company:** VividWalls — Premium AI-generated wall art
- **Revenue Model:** Product sales (prints, canvases, custom art)
- **Current Stage:** Pre-revenue / early revenue

## Financial Metrics
- **Revenue Target:** $30K+/month → $15M ARR by Year 2
- **Marketing Budget:** $2K/month (strict cap without stakeholder approval)
- **Target ROAS:** 15x ($30K revenue / $2K spend)
- **Gross Margin Target:** 65-70% (print-on-demand model)

## Assumptions
- Customer Acquisition Cost (CAC) must stay below $25
- Average Order Value (AOV) estimated $75-150 for premium art
- Lifetime Value (LTV) target: 2.5x AOV with repeat purchases
- Break-even expected within 6 months of launch
- Cash runway must exceed 6 months at all times

## Cost Structure
- **COGS:** Print production, shipping, packaging (~30-35% of revenue)
- **Marketing:** $2K/month fixed, performance-based scaling
- **Technology:** Hosting, AI generation, platform costs
- **Operations:** Fulfillment partners, customer service tools

## Constraints
- Conservative financial projections required
- All spending tracked and auditable
- Vendor payments within 30-day terms
- Tax compliance across operating jurisdictions
`,

  coo: `# Beliefs — COO

## Operational Context
- **Company:** VividWalls — Premium wall art e-commerce
- **Fulfillment Model:** Print-on-demand with fulfillment partners
- **Automation Target:** 95% for routine tasks

## Current Operations
- **Order Processing:** Targeting 80% reduction in processing time
- **Fulfillment Pipeline:** Order → Print → QC → Ship → Deliver
- **Shipping Partners:** To be established with 2-3 tier providers
- **Average Processing Time Target:** < 48 hours from order to ship

## Process Inventory
- Order intake and validation (automated)
- Payment processing and fraud detection (automated)
- Print queue management (semi-automated)
- Quality control checkpoints (manual review for custom orders)
- Shipping label generation and tracking (automated)
- Customer notification pipeline (automated)
- Returns and exchanges handling (semi-automated)

## Constraints
- System uptime must remain above 99% during business hours
- Customer-facing processes require < 2 second response times
- Automation must include human oversight for critical decisions
- Fulfillment SLA: 5-7 business days standard, 2-3 days express
`,

  cmo: `# Beliefs — CMO

## Market Position
- **Brand:** VividWalls — Premium AI-generated wall art
- **Target Audience:** Millennials and Gen-Z homeowners/renters, interior design enthusiasts
- **Price Range:** $49-$299 (prints to large canvases)
- **USP:** Curated AI art, premium quality, customizable sizing

## Channel Performance (Targets)
- **Instagram:** Primary visual discovery channel, targeting 10K followers in 90 days
- **Pinterest:** High-intent traffic for home decor, targeting 50K monthly impressions
- **Facebook/Meta Ads:** Primary paid acquisition channel, ROAS target 15x
- **Email:** Nurture channel, targeting 3,000 subscribers in 3 months
- **TikTok:** Brand awareness, trending art content
- **WhatsApp Business:** Direct customer engagement and nurture sequences

## Audience Insights
- 25-44 age demographic primary buyers
- Female-skewing (65/35) for home decor purchases
- Interior design, minimalism, abstract art top interest signals
- Mobile-first browsing, desktop conversion

## Ad Spend Constraints
- Total monthly budget: $2K (strict cap)
- Allocation: 60% Meta Ads, 20% Pinterest Ads, 20% experimental
- ROAS threshold for scaling: 2x for 3+ consecutive days
- Escalation required if total spend approaches budget threshold
`,

  cto: `# Beliefs — CTO

## System Architecture
- **Platform:** MABOS (Multi-Agent Business Operating System)
- **Stack:** Node.js/TypeScript, React frontend, PostgreSQL + TypeDB
- **Hosting:** Cloud-based with CDN for static assets
- **AI Engine:** Generative art models for product creation

## System Metrics
- **Uptime Target:** 99.9% (delegated stakeholder goal)
- **Response Time:** < 2s for customer-facing pages
- **Deployment Frequency:** Multiple daily deploys via CI/CD
- **MTTR Target:** < 30 minutes for critical incidents

## Tech Constraints
- All systems must handle concurrent agent operations
- Real-time event bus for inter-agent communication
- Data encryption at rest and in transit
- GDPR/CCPA technical compliance (data deletion, export)
- Automated backup with < 1 hour RPO

## Current Systems
- Agent orchestration framework (MABOS core)
- E-commerce storefront (product catalog, cart, checkout)
- AI art generation pipeline
- Order management system
- CRM and customer communication
- Analytics and reporting dashboards
`,

  hr: `# Beliefs — HR

## Team Composition
- **Agent Team:** 17 AI agents (9 C-suite + 8 department managers)
- **Human Team:** Stakeholder (founder) + freelance contractors as needed
- **Contractor Pool:** Designers, developers, content creators, print specialists

## Workforce Model
- AI agents handle 95% of routine operations
- Human contractors for specialized creative work, QC, and oversight
- Stakeholder provides strategic direction and critical decision approval

## Hiring Pipeline
- Freelance platforms: Upwork, Fiverr, 99designs for creative work
- Direct outreach for specialized print-on-demand partners
- Contract-based engagement (per-project or monthly retainer)

## Compliance Requirements
- Contractor agreements with clear scope and deliverables
- NDA requirements for all contractors accessing business data
- Payment terms: Net-15 for small contracts, Net-30 for retainers
- IP assignment clauses in all creative contracts
`,

  legal: `# Beliefs — Legal

## Regulatory Environment
- **E-commerce:** Consumer protection laws, FTC advertising guidelines
- **Privacy:** GDPR (EU customers), CCPA (California), general data protection
- **IP:** Copyright considerations for AI-generated art
- **Tax:** Sales tax nexus across US states, VAT for international

## IP Status
- **Brand:** VividWalls trademark (to be filed)
- **AI Art:** Copyright status of AI-generated works — evolving legal landscape
- **Content:** All marketing copy and brand assets company-owned
- **Trade Secrets:** AI art curation algorithms, customer persona models

## Contract Templates
- Freelancer service agreement (with IP assignment)
- Non-disclosure agreement (mutual and one-way)
- Customer terms of service
- Privacy policy (GDPR/CCPA compliant)
- Print partner service level agreement
- Affiliate/referral agreement

## Compliance Priorities
- GDPR/CCPA compliance across all operations (delegated stakeholder goal, priority 0.95)
- Cookie consent and tracking transparency
- Email marketing CAN-SPAM compliance
- Advertising disclosure requirements (FTC)
`,

  strategy: `# Beliefs — Strategy

## Market Position
- **Segment:** Premium AI-generated wall art
- **Market Size:** $44B global wall art market, AI art sub-segment emerging
- **Target Capture:** 15% of premium segment within 24 months
- **Growth Trajectory:** Hockey-stick model — slow build → rapid scaling

## Competitive Analysis
- **Mass-market:** Society6, Redbubble (low price, high volume, commodity feel)
- **Premium traditional:** Minted, Artfully Walls (curated but expensive)
- **AI newcomers:** Scattered, no brand loyalty yet
- **VividWalls positioning:** Premium quality + AI innovation + accessible pricing

## Strategic Pillars
1. **Product Differentiation:** Curated AI art (not random generation)
2. **Customer Experience:** Personalized recommendations, room visualization
3. **Operational Excellence:** 95% automation, fast fulfillment
4. **Brand Building:** Thought leadership in AI art space

## Growth Model
- Phase 1 (0-6mo): Product-market fit, initial traction, $30K MRR
- Phase 2 (6-18mo): Channel scaling, repeat customers, $500K MRR
- Phase 3 (18-24mo): Market expansion, B2B, $1.25M MRR → $15M ARR
`,

  knowledge: `# Beliefs — Knowledge Manager

## Ontology Coverage
- **Business Domain:** E-commerce, wall art, interior design, print production
- **Technical Domain:** MABOS architecture, AI generation, web technologies
- **Market Domain:** Customer segments, competitors, channels, pricing
- **Operational Domain:** Fulfillment, shipping, customer service workflows

## Knowledge Gap Analysis
- AI art copyright case law — rapidly evolving, needs continuous monitoring
- International shipping regulations by country — partially mapped
- Customer preference modeling — initial segments defined, needs refinement
- Print quality specifications by material type — vendor-dependent

## Data Source Inventory
- Internal: Agent memory stores, case-based reasoning library, event logs
- External: Market research databases, competitor monitoring, social listening
- Customer: Purchase history, browsing behavior, feedback surveys
- Operational: Fulfillment metrics, shipping data, return reasons

## Knowledge Architecture
- SBVR business rules for policy enforcement
- Tropos goal model for strategic alignment
- BDI state management per agent
- Case-based reasoning library for decision support
- Ontology graph in TypeDB for relationship queries
`,

  "inventory-mgr": `# Beliefs — Inventory Manager

## Product Catalog
- **Art Styles:** Abstract, minimalist, nature, geometric, portrait, custom
- **Print Types:** Paper prints, canvas wraps, framed prints, metal prints
- **Sizes:** Small (8x10), Medium (16x20), Large (24x36), XL (30x40), Custom
- **Production Model:** Print-on-demand (no physical inventory held)

## Supplier Network
- Primary print partner: To be established (quality + speed priority)
- Backup print partner: For overflow and redundancy
- Frame suppliers: Sourced per-order based on customer selection
- Packaging materials: Bulk-ordered, stored at fulfillment center

## Key Metrics
- Print defect rate: Target < 2%
- Stock-out risk: N/A for digital catalog (infinite virtual inventory)
- Material cost tracking per SKU
- Supplier lead time monitoring

## Constraints
- Custom orders require 24-48 hour additional processing
- International shipping adds 5-10 business days
- Oversized prints (>30x40) require special packaging
`,

  "fulfillment-mgr": `# Beliefs — Fulfillment Manager

## Fulfillment Pipeline (Pictorem CDP Automation)
- **Stage 1:** Shopify order paid → webhook → Payment Bridge (port 3001)
- **Stage 2:** Bridge looks up print-ready image from PostgreSQL media_assets
- **Stage 3:** If image found → download/locate → submit to Pictorem via CDP browser automation
- **Stage 4:** Pictorem processes order (Image Amplify + Expert Retouch + varnish)
- **Stage 5:** Pictorem ships direct to customer; bridge records result in fulfillment-queue JSON

## Status States
| Status | Meaning |
|--------|---------|
| pending_fulfillment | Queued, awaiting Pictorem submission |
| submitted_to_pictorem | Successfully submitted via CDP |
| image_download_failed | Print-ready image could not be fetched |
| automation_error | CDP automation hit an error |
| automation_partial | Some CDP steps completed, unclear final state |
| submission_failed | Pictorem submission threw an exception |
| blocked_no_print_image | No print-ready original in database |

## Performance Targets
- Auto-fulfillment rate: > 95% of paid orders
- Error rate: < 5% of pipeline items
- Retry-to-resolution: < 20 minutes
- Bridge uptime: > 99%

## Current State
- Pictorem is the sole print partner (CDP automation, not API)
- Payment Bridge runs on VPS port 3001 as a standalone Express service
- MABOS agents access the bridge via 5 pictorem_* tools (HTTP to localhost:3001/api/*)
- Fulfillment queue stored as JSON files in data/fulfillment-queue/
- Edition numbers tracked via Shopify metafields
- Business card auto-charged via Stripe for Pictorem costs

## Constraints
- CDP automation is brittle — Chrome/Pictorem UI changes can break it
- One order at a time (browser automation is sequential)
- No Pictorem API — all interaction via browser
- Bridge must be restarted to pick up .env changes
`,

  "product-mgr": `# Beliefs — Product Manager

## Product Strategy
- **Core Product:** AI-generated wall art prints and canvases
- **Differentiator:** Curated collections, not random AI output
- **Pricing Strategy:** Premium positioning ($49-$299 range)
- **Product Roadmap:** Expand to custom commissions, room visualization, subscriptions

## Product Lines
1. **Signature Collection:** Curated best-sellers, limited editions
2. **Style Collections:** Abstract, Nature, Minimalist, Geometric, etc.
3. **Custom Art:** Customer-directed AI generation with revision rounds
4. **Room Bundles:** Coordinated multi-piece sets for rooms

## Customer Insights
- Top selling styles: Abstract and minimalist (60% of sales)
- Most requested feature: Room visualization / AR preview
- Price sensitivity: Sweet spot at $79-$129 for medium prints
- Repeat purchase trigger: New collection drops, seasonal themes

## Constraints
- New collections require CEO approval before launch
- Pricing changes need CFO sign-off
- Custom art turnaround: 48-72 hours including revisions
`,

  "marketing-director": `# Beliefs — Marketing Director

## Channel Strategy
- Reports to: CMO
- **Primary Channels:** Meta Ads, Instagram organic, Pinterest, Email
- **Secondary Channels:** TikTok, Google Ads, Influencer partnerships
- **Content Strategy:** Visual-first, lifestyle imagery, room mockups

## Campaign Performance (Targets)
- Meta Ads ROAS: 15x minimum
- Email open rate: 25%+
- Social engagement rate: 3%+
- Content publishing: 5+ posts/week across platforms

## Audience Segments
- **Primary:** Female 25-44, homeowner/renter, design-conscious
- **Secondary:** Interior designers, home stagers, real estate agents
- **Tertiary:** Gift buyers (seasonal spikes)

## Current Initiatives
- Building initial content library (product shots, lifestyle images)
- Setting up Meta pixel and conversion tracking
- Email welcome sequence design
- Influencer outreach list compilation
`,

  "sales-director": `# Beliefs — Sales Director

## Sales Strategy
- **Model:** E-commerce self-service with AI-assisted recommendations
- **Conversion Target:** 3.5%+ on art sales
- **AOV Target:** $75-$150
- **Sales Personas:** 13 targeted personas to deploy

## Sales Funnel
- **Awareness:** Social media, content marketing, SEO
- **Interest:** Product pages, collections, room visualization
- **Decision:** Reviews, guarantees, limited editions urgency
- **Action:** Streamlined checkout, multiple payment options
- **Retention:** Email nurture, new collection alerts, loyalty program

## Customer Segments
- First-time art buyers (need education, social proof)
- Design enthusiasts (want uniqueness, limited editions)
- Gift shoppers (seasonal, need gift wrapping, messaging)
- B2B (designers, offices) — future segment

## Constraints
- Sales personas must be ethical and non-manipulative
- No high-pressure tactics or false scarcity
- Pricing transparency required
- Return policy must be clearly displayed
`,

  "compliance-director": `# Beliefs — Compliance Director

## Regulatory Framework
- Reports to: Legal Agent
- **Privacy:** GDPR (EU), CCPA (California), PIPEDA (Canada)
- **E-commerce:** FTC guidelines, consumer protection, advertising standards
- **Financial:** PCI-DSS for payment processing, sales tax compliance
- **Communications:** CAN-SPAM, TCPA for SMS, CASL for Canada

## Compliance Status
- Privacy policy: Drafted, needs legal review
- Cookie consent: Implementation in progress
- Data processing agreements: Template ready
- Payment compliance: PCI-DSS via payment processor (Stripe)

## Monitoring Areas
- Customer data collection and storage practices
- Marketing communications opt-in/opt-out
- AI art copyright and fair use considerations
- Cross-border data transfer mechanisms
- Accessibility standards (WCAG 2.1 AA)

## Constraints
- All new features require compliance review before launch
- Customer data deletion requests: 30-day SLA
- Data breach notification: 72 hours (GDPR requirement)
`,

  "creative-director": `# Beliefs — Creative Director

## Brand Identity
- **Brand Voice:** Sophisticated yet approachable, art-forward, modern
- **Visual Style:** Clean, minimal layouts with art as hero element
- **Color Palette:** Neutral backgrounds, letting art colors dominate
- **Typography:** Modern sans-serif, readable, elegant

## Creative Assets
- Product photography style guide (in development)
- Social media templates (Instagram, Pinterest, Facebook)
- Email design system
- Website UI/UX design patterns
- Packaging design standards

## AI Art Curation Criteria
- Aesthetic quality score > 8/10
- Style consistency within collections
- Print reproduction quality verified
- No copyright-infringing elements
- Diversity in subjects, styles, and color palettes

## Constraints
- Brand guidelines must be followed across all channels
- AI-generated content requires human creative review
- Custom art revisions limited to 3 rounds per order
`,

  "cs-director": `# Beliefs — Customer Service Director

## Service Model
- **Primary Channel:** Email support with < 24 hour response time
- **Secondary:** Live chat during business hours, WhatsApp Business
- **Self-Service:** FAQ, order tracking, returns portal
- **Escalation Path:** CS Agent → CS Director → COO → CEO

## Customer Satisfaction
- **CSAT Target:** 90%+ (delegated stakeholder goal)
- **First Response Time:** < 4 hours during business hours
- **Resolution Time:** < 24 hours for standard issues
- **First Contact Resolution:** 80%+ target

## Common Issue Categories
1. Order status inquiries (40%) — automated tracking response
2. Shipping delays/damage (20%) — escalation to fulfillment
3. Return/exchange requests (15%) — automated portal
4. Product questions (15%) — AI-assisted responses
5. Payment issues (10%) — escalation to finance

## Constraints
- Customer satisfaction cannot be traded for cost savings
- Refunds processed within 5-7 business days
- Replacement orders ship within 48 hours of approval
- All customer interactions logged for quality review
`,
};

// ── Goals Content ──

const TROPOS_GOALS: Record<string, string[]> = {
  ceo: [
    "Deploy 13 sales personas for targeted conversion",
    "Achieve 3.5%+ conversion rate on art sales",
    "Achieve 90%+ customer satisfaction (CSAT)",
  ],
  cfo: ["Achieve $15M ARR by Year 2"],
  coo: ["Achieve 95% automation rate for routine tasks", "Reduce order processing time by 80%"],
  cmo: [
    "Generate $30K+ monthly revenue from $2K marketing spend",
    "Build 3,000+ email subscriber base in 3 months",
  ],
  cto: ["Maintain 99.9% system uptime"],
  hr: [],
  legal: ["Ensure GDPR/CCPA compliance across all operations"],
  strategy: ["Capture 15% premium wall art market in 24 months"],
  knowledge: [],
};

function generateGoals(agentId: AgentId): string {
  const delegated = TROPOS_GOALS[agentId] || [];
  const subGoals: Record<string, string[][]> = {
    ceo: [
      [
        "G-CEO-1",
        "Deploy 13 sales personas for targeted conversion",
        "1.0",
        [
          "Define persona profiles based on customer segments",
          "Implement persona-based product recommendations",
          "A/B test persona messaging for conversion lift",
          "Deploy all 13 personas with tracking metrics",
        ].join("\\n   - "),
      ].flat() as any,
    ],
    cfo: [],
    coo: [],
    cmo: [],
    cto: [],
  };

  let md = `# Goals — ${agentId.toUpperCase()}\n\n## Delegated Goals (from Tropos Goal Model)\n\n`;

  if (delegated.length === 0) {
    md += `No directly delegated stakeholder goals. This agent supports other agents' goals.\n\n`;
  } else {
    delegated.forEach((g, i) => {
      md += `### DG-${i + 1}: ${g}\n- **Source:** Stakeholder delegation via Tropos model\n- **Type:** achieve\n- **Status:** active\n\n`;
    });
  }

  md += `## Decomposed Sub-Goals\n\n`;

  // Generate role-specific sub-goals
  const roleGoals: Record<string, string> = {
    ceo: `### G-CEO-1: Define and deploy all 13 sales personas
- **Parent:** DG-1
- **KPI:** Number of active personas with conversion data
- **Target:** 13 personas live by end of Q1 2026
- **Dependencies:** Marketing Director (audience data), Sales Director (conversion tracking)

### G-CEO-2: Optimize conversion funnel to 3.5%+
- **Parent:** DG-2
- **KPI:** Site-wide conversion rate
- **Target:** 3.5% by month 3
- **Dependencies:** CTO (A/B testing infrastructure), Product Manager (UX optimization)

### G-CEO-3: Achieve and maintain 90%+ CSAT
- **Parent:** DG-3
- **KPI:** Monthly CSAT survey score
- **Target:** 90%+ sustained over 3 months
- **Dependencies:** CS Director (service quality), Fulfillment Manager (delivery experience)`,

    cfo: `### G-CFO-1: Build revenue model to $30K MRR
- **Parent:** DG-1
- **KPI:** Monthly Recurring Revenue
- **Target:** $30K MRR within 6 months
- **Dependencies:** CMO (marketing-driven revenue), Sales Director (conversion)

### G-CFO-2: Establish financial reporting cadence
- **KPI:** Report accuracy and timeliness
- **Target:** Weekly cash flow, monthly P&L, quarterly forecast
- **Dependencies:** All agents (expense data)

### G-CFO-3: Optimize unit economics
- **KPI:** CAC, LTV, gross margin
- **Target:** LTV:CAC > 3:1, gross margin > 65%
- **Dependencies:** CMO (CAC data), COO (COGS optimization)`,

    coo: `### G-COO-1: Automate 95% of routine business tasks
- **Parent:** DG-1
- **KPI:** Automation rate across processes
- **Target:** 95% by end of Q2 2026
- **Dependencies:** CTO (automation infrastructure), all department managers

### G-COO-2: Reduce order processing to < 48 hours
- **Parent:** DG-2
- **KPI:** Average order-to-ship time
- **Target:** < 48 hours standard, < 24 hours express
- **Dependencies:** Fulfillment Manager, Inventory Manager, print partners

### G-COO-3: Establish operations dashboard
- **KPI:** Dashboard completeness and freshness
- **Target:** Real-time metrics for all key processes
- **Dependencies:** CTO (monitoring infrastructure)`,

    cmo: `### G-CMO-1: Achieve 15x ROAS on marketing spend
- **Parent:** DG-1
- **KPI:** Return on Ad Spend
- **Target:** $30K revenue from $2K spend = 15x ROAS
- **Dependencies:** Marketing Director (campaign execution), Creative Director (ad creative)

### G-CMO-2: Build email list to 3,000 subscribers
- **Parent:** DG-2
- **KPI:** Email subscriber count
- **Target:** 3,000 in 90 days (33/day run rate)
- **Dependencies:** Marketing Director (lead magnets), CTO (email infrastructure)

### G-CMO-3: Establish brand presence on 5+ social platforms
- **KPI:** Active platform count with consistent posting
- **Target:** Instagram, Pinterest, Facebook, TikTok, LinkedIn
- **Dependencies:** Creative Director (content), Marketing Director (scheduling)`,

    cto: `### G-CTO-1: Achieve and maintain 99.9% uptime
- **Parent:** DG-1
- **KPI:** Monthly uptime percentage
- **Target:** 99.9% (< 43 min downtime/month)
- **Dependencies:** No external dependencies

### G-CTO-2: Deploy monitoring and alerting stack
- **KPI:** Alert coverage, MTTR
- **Target:** < 5 min detection, < 30 min resolution for P1
- **Dependencies:** COO (incident response procedures)

### G-CTO-3: Implement CI/CD pipeline
- **KPI:** Deployment frequency, failure rate
- **Target:** Multiple daily deploys, < 5% failure rate
- **Dependencies:** No external dependencies`,

    hr: `### G-HR-1: Build contractor sourcing pipeline
- **KPI:** Qualified candidates per role type
- **Target:** 5+ vetted contractors per skill category
- **Dependencies:** Legal (contract templates), CFO (budget approval)

### G-HR-2: Create onboarding workflow
- **KPI:** Time-to-productivity for new contractors
- **Target:** < 1 week from contract to first deliverable
- **Dependencies:** Legal (NDAs), CTO (access provisioning)`,

    legal: `### G-LEGAL-1: Achieve full GDPR/CCPA compliance
- **Parent:** DG-1
- **KPI:** Compliance audit score
- **Target:** 100% compliance on all mandatory items
- **Dependencies:** CTO (technical implementation), Compliance Director (monitoring)

### G-LEGAL-2: Establish contract template library
- **KPI:** Template coverage for all engagement types
- **Target:** 6 templates ready (freelancer, NDA, ToS, privacy, SLA, affiliate)
- **Dependencies:** HR (contractor needs), COO (vendor needs)

### G-LEGAL-3: File VividWalls trademark
- **KPI:** Filing status
- **Target:** Trademark application submitted Q1 2026
- **Dependencies:** CFO (filing fees budget)`,

    strategy: `### G-STRAT-1: Define market capture roadmap
- **Parent:** DG-1
- **KPI:** Market share estimation methodology established
- **Target:** 15% of premium segment in 24 months
- **Dependencies:** Knowledge Manager (market data), CMO (channel strategy)

### G-STRAT-2: Complete competitive analysis
- **KPI:** Competitor profiles completed
- **Target:** Top 10 competitors fully profiled with SWOT
- **Dependencies:** Knowledge Manager (research data)

### G-STRAT-3: Establish quarterly strategy review cadence
- **KPI:** Review completion and action item tracking
- **Target:** First review end of Q1 2026
- **Dependencies:** CEO (approval), all C-suite (input)`,

    knowledge: `### G-KM-1: Build VividWalls business ontology
- **KPI:** Concept coverage percentage
- **Target:** 80% of core business concepts mapped
- **Dependencies:** All agents (domain expertise input)

### G-KM-2: Establish case-based reasoning library
- **KPI:** Case count and retrieval accuracy
- **Target:** 50+ cases covering key business decisions
- **Dependencies:** All agents (case contributions)

### G-KM-3: Set up knowledge audit cycle
- **KPI:** Audit frequency and correction rate
- **Target:** Monthly audits, < 5% stale knowledge
- **Dependencies:** No external dependencies`,

    "inventory-mgr": `### G-INV-1: Establish print partner relationships
- **KPI:** Active print partners with SLAs
- **Target:** 2 qualified partners (primary + backup)
- **Dependencies:** COO (vendor evaluation), Legal (contracts), CFO (terms)

### G-INV-2: Build product catalog to 500+ designs
- **KPI:** Active SKU count
- **Target:** 500 designs across 6 style categories
- **Dependencies:** Creative Director (design curation), Product Manager (catalog structure)`,

    "fulfillment-mgr": `### G-FUL-1: Achieve > 95% auto-fulfillment rate
- **KPI:** submitted_to_pictorem / total orders
- **Target:** > 95%
- **Measurement:** \`pictorem_pipeline_stats\` → error_rate < 0.05
- **Dependencies:** CTO (bridge stability), Inventory Manager (print-ready images)

### G-FUL-2: Maintain < 5% pipeline error rate
- **KPI:** Error items / total items
- **Target:** < 5%
- **Measurement:** \`pictorem_pipeline_stats\` → error_rate
- **Dependencies:** CTO (CDP automation reliability)

### G-FUL-3: Resolve failures within 20 minutes
- **KPI:** Time from error to successful retry
- **Target:** < 20 minutes for retryable errors
- **Measurement:** retried_at - created_at on queue items
- **Dependencies:** Fulfillment Manager (monitoring), CTO (fix automation bugs)`,

    "product-mgr": `### G-PM-1: Launch Signature Collection
- **KPI:** Collection live with 50+ pieces
- **Target:** Launch within 30 days
- **Dependencies:** Creative Director (curation), CTO (catalog system)

### G-PM-2: Implement room visualization feature
- **KPI:** Feature live and adoption rate
- **Target:** 20% of visitors use feature
- **Dependencies:** CTO (AR/visualization tech)`,

    "marketing-director": `### G-MKTD-1: Execute social media launch sequence
- **KPI:** Follower growth, engagement rate
- **Target:** 10K Instagram followers in 90 days
- **Dependencies:** Creative Director (content), CMO (budget approval)

### G-MKTD-2: Build and optimize Meta Ads campaigns
- **KPI:** ROAS, CPA
- **Target:** ROAS > 2x within first 30 days, scaling to 15x
- **Dependencies:** CMO (budget), Creative Director (ad creative)`,

    "sales-director": `### G-SD-1: Deploy 13 sales personas
- **KPI:** Active personas with tracking
- **Target:** All 13 live by end of Q1 2026
- **Dependencies:** CEO (persona definitions), Marketing Director (audience data)

### G-SD-2: Optimize checkout conversion to 3.5%+
- **KPI:** Checkout conversion rate
- **Target:** 3.5%+ sustained
- **Dependencies:** CTO (checkout optimization), Product Manager (UX)`,

    "compliance-director": `### G-CD-1: Complete GDPR/CCPA compliance audit
- **KPI:** Audit completion, findings resolved
- **Target:** Full audit complete, 100% critical items resolved
- **Dependencies:** CTO (technical controls), Legal (policy review)

### G-CD-2: Implement cookie consent and tracking compliance
- **KPI:** Consent rate, compliance score
- **Target:** 100% pages covered, opt-in rate > 60%
- **Dependencies:** CTO (implementation)`,

    "creative-director": `### G-CRTV-1: Establish brand style guide
- **KPI:** Guide completeness
- **Target:** Comprehensive guide covering all channels
- **Dependencies:** CMO (brand strategy), CEO (approval)

### G-CRTV-2: Build content library of 200+ assets
- **KPI:** Asset count and variety
- **Target:** 200 assets (product shots, lifestyle, social templates)
- **Dependencies:** Product Manager (product photos), Marketing Director (needs)`,

    "cs-director": `### G-CS-1: Achieve 90%+ CSAT score
- **KPI:** Monthly CSAT survey results
- **Target:** 90%+ sustained
- **Dependencies:** Fulfillment Manager (delivery quality), Product Manager (product quality)

### G-CS-2: Build self-service support portal
- **KPI:** Self-service resolution rate
- **Target:** 50% of inquiries resolved via self-service
- **Dependencies:** CTO (portal development), Knowledge Manager (FAQ content)`,
  };

  md += roleGoals[agentId] || "Goals to be decomposed from director-level objectives.\n";
  md += "\n";
  return md;
}

// ── Intentions Content ──

function generateIntentions(agentId: AgentId): string {
  const intentionsByAgent: Record<string, string> = {
    ceo: `# Intentions — CEO

## Active Intentions

### INT-CEO-1: Orchestrate sales persona deployment
- **Goal:** G-CEO-1 (Deploy 13 sales personas)
- **Plan:** P-CEO-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Highest-priority delegated goal from stakeholder

### INT-CEO-2: Establish cross-agent coordination cadence
- **Goal:** G-CEO-3 (90%+ CSAT — requires multi-agent alignment)
- **Plan:** P-CEO-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** CSAT depends on fulfillment, CS, and product quality alignment

## Suspended Intentions

_None currently._

## Completed Intentions

_None yet — system initialized 2026-02-17._
`,
    cfo: `# Intentions — CFO

## Active Intentions

### INT-CFO-1: Build revenue tracking and forecasting model
- **Goal:** G-CFO-1 ($30K MRR target)
- **Plan:** P-CFO-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Cannot manage revenue growth without measurement

### INT-CFO-2: Establish financial reporting cadence
- **Goal:** G-CFO-2
- **Plan:** P-CFO-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Foundation for all financial decisions

## Suspended Intentions

_None currently._
`,
    coo: `# Intentions — COO

## Active Intentions

### INT-COO-1: Map and automate core business processes
- **Goal:** G-COO-1 (95% automation)
- **Plan:** P-COO-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Automation is prerequisite for scaling operations

### INT-COO-2: Establish fulfillment pipeline with SLAs
- **Goal:** G-COO-2 (< 48h processing)
- **Plan:** P-COO-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Order processing is the core operational flow

## Suspended Intentions

_None currently._
`,
    cmo: `# Intentions — CMO

## Active Intentions

### INT-CMO-1: Launch multi-channel marketing campaign
- **Goal:** G-CMO-1 (15x ROAS)
- **Plan:** P-CMO-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Revenue generation is top priority

### INT-CMO-2: Execute email list building strategy
- **Goal:** G-CMO-2 (3,000 subscribers)
- **Plan:** P-CMO-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Email is highest-ROI owned channel

## Suspended Intentions

_None currently._
`,
    cto: `# Intentions — CTO

## Active Intentions

### INT-CTO-1: Deploy monitoring and alerting for 99.9% uptime
- **Goal:** G-CTO-1
- **Plan:** P-CTO-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Cannot maintain uptime without observability

### INT-CTO-2: Harden CI/CD pipeline
- **Goal:** G-CTO-3
- **Plan:** P-CTO-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Deployment reliability underpins all system changes

## Suspended Intentions

_None currently._
`,
    hr: `# Intentions — HR

## Active Intentions

### INT-HR-1: Build contractor sourcing pipeline
- **Goal:** G-HR-1
- **Plan:** P-HR-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Business needs specialized contractors for launch phase

### INT-HR-2: Create standardized onboarding workflow
- **Goal:** G-HR-2
- **Plan:** P-HR-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Consistent onboarding reduces time-to-productivity

## Suspended Intentions

_None currently._
`,
    legal: `# Intentions — Legal

## Active Intentions

### INT-LEGAL-1: Complete GDPR/CCPA compliance implementation
- **Goal:** G-LEGAL-1
- **Plan:** P-LEGAL-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Compliance is non-negotiable, highest priority (0.95)

### INT-LEGAL-2: Prepare contract template library
- **Goal:** G-LEGAL-2
- **Plan:** P-LEGAL-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** HR and COO need contracts for vendor/contractor engagement

## Suspended Intentions

_None currently._
`,
    strategy: `# Intentions — Strategy

## Active Intentions

### INT-STRAT-1: Develop market capture roadmap
- **Goal:** G-STRAT-1
- **Plan:** P-STRAT-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Strategic direction needed before scaling investments

### INT-STRAT-2: Complete competitive landscape analysis
- **Goal:** G-STRAT-2
- **Plan:** P-STRAT-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Competitive intelligence informs positioning decisions

## Suspended Intentions

_None currently._
`,
    knowledge: `# Intentions — Knowledge Manager

## Active Intentions

### INT-KM-1: Build core business ontology
- **Goal:** G-KM-1
- **Plan:** P-KM-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Ontology is foundation for agent reasoning

### INT-KM-2: Seed case-based reasoning library
- **Goal:** G-KM-2
- **Plan:** P-KM-2
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** CBR library needed for decision support

## Suspended Intentions

_None currently._
`,
  };

  // Domain agents follow a similar pattern referencing their director
  const domainIntentions: Record<string, string> = {
    "inventory-mgr": `# Intentions — Inventory Manager

## Active Intentions

### INT-INV-1: Establish print partner relationships
- **Goal:** G-INV-1
- **Plan:** P-INV-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** No production capability without print partners

### INT-INV-2: Build initial product catalog
- **Goal:** G-INV-2
- **Plan:** P-INV-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Catalog is prerequisite for sales

## Suspended Intentions

_None currently._
`,
    "fulfillment-mgr": `# Intentions — Fulfillment Manager

## Active Intentions

### INT-FUL-1: Operate Pictorem fulfillment pipeline
- **Goal:** G-FUL-1
- **Plan:** P-FUL-1
- **Status:** active
- **Adopted:** 2026-03-04
- **Reason:** Pipeline is live — must monitor and maintain > 95% auto-fulfillment
- **Tools:** pictorem_pipeline_stats, pictorem_queue_list, pictorem_order_status

### INT-FUL-2: Minimize pipeline failures
- **Goal:** G-FUL-2, G-FUL-3
- **Plan:** P-FUL-2
- **Status:** active
- **Adopted:** 2026-03-04
- **Reason:** Errors degrade customer experience; retries must be fast
- **Tools:** pictorem_retry_fulfillment, pictorem_order_status

## Suspended Intentions

_None currently._
`,
    "product-mgr": `# Intentions — Product Manager

## Active Intentions

### INT-PM-1: Launch Signature Collection
- **Goal:** G-PM-1
- **Plan:** P-PM-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Need initial product offering for launch

### INT-PM-2: Define product roadmap
- **Goal:** G-PM-2
- **Plan:** P-PM-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Room visualization is top customer request

## Suspended Intentions

_None currently._
`,
    "marketing-director": `# Intentions — Marketing Director

## Active Intentions

### INT-MKTD-1: Execute social media launch sequence
- **Goal:** G-MKTD-1
- **Plan:** P-MKTD-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** CMO directive — social media launch is immediate priority

### INT-MKTD-2: Set up and optimize Meta Ads campaigns
- **Goal:** G-MKTD-2
- **Plan:** P-MKTD-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Paid acquisition is primary revenue driver

## Suspended Intentions

_None currently._
`,
    "sales-director": `# Intentions — Sales Director

## Active Intentions

### INT-SD-1: Deploy initial sales personas
- **Goal:** G-SD-1
- **Plan:** P-SD-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** CEO directive — personas are top priority

### INT-SD-2: Optimize checkout flow
- **Goal:** G-SD-2
- **Plan:** P-SD-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Conversion rate directly impacts revenue

## Suspended Intentions

_None currently._
`,
    "compliance-director": `# Intentions — Compliance Director

## Active Intentions

### INT-CD-1: Conduct GDPR/CCPA compliance audit
- **Goal:** G-CD-1
- **Plan:** P-CD-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Legal directive — compliance is non-negotiable

### INT-CD-2: Implement cookie consent framework
- **Goal:** G-CD-2
- **Plan:** P-CD-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Required for GDPR compliance before going live

## Suspended Intentions

_None currently._
`,
    "creative-director": `# Intentions — Creative Director

## Active Intentions

### INT-CRTV-1: Create brand style guide
- **Goal:** G-CRTV-1
- **Plan:** P-CRTV-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** All creative work depends on brand guidelines

### INT-CRTV-2: Build initial content library
- **Goal:** G-CRTV-2
- **Plan:** P-CRTV-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Marketing Director needs assets for campaign launch

## Suspended Intentions

_None currently._
`,
    "cs-director": `# Intentions — Customer Service Director

## Active Intentions

### INT-CS-1: Set up customer service infrastructure
- **Goal:** G-CS-1
- **Plan:** P-CS-1
- **Status:** active
- **Adopted:** 2026-02-17
- **Reason:** Must be ready before first customer orders

### INT-CS-2: Build FAQ and self-service portal
- **Goal:** G-CS-2
- **Plan:** P-CS-2
- **Status:** active
- **Adopted:** 2026-02-18
- **Reason:** Self-service reduces support load and improves CSAT

## Suspended Intentions

_None currently._
`,
  };

  return (
    intentionsByAgent[agentId] ||
    domainIntentions[agentId] ||
    `# Intentions — ${agentId}\n\n_No active intentions._\n`
  );
}

// ── Plans Content ──

function generatePlans(agentId: AgentId): string {
  const plansByAgent: Record<string, string> = {
    ceo: `# Plans — CEO

## Active Plans

### P-CEO-1: Sales Persona Deployment
- **Intention:** INT-CEO-1
- **Template:** PT-005 (Strategic Decision Framework)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define 13 persona profiles based on customer segmentation data
2. [pending] Review personas with Sales Director for feasibility
3. [pending] Coordinate with CTO for persona recommendation engine
4. [pending] Coordinate with Marketing Director for persona-targeted campaigns
5. [pending] Deploy personas in phased rollout (3 → 7 → 13)
6. [pending] Monitor conversion metrics per persona for 2 weeks
7. [pending] Optimize underperforming personas based on data

### P-CEO-2: Cross-Agent CSAT Coordination
- **Intention:** INT-CEO-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Establish weekly agent sync meeting cadence
2. [pending] Define CSAT contribution matrix (which agents affect which CSAT drivers)
3. [pending] Set up CSAT dashboard with CS Director
4. [pending] Create escalation protocol for CSAT drops below 85%
`,
    cfo: `# Plans — CFO

## Active Plans

### P-CFO-1: Revenue Tracking Model
- **Intention:** INT-CFO-1
- **Template:** PT-002 (Financial Health Check)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Set up revenue tracking spreadsheet/dashboard
2. [pending] Define KPIs: MRR, AOV, conversion rate, CAC, LTV
3. [pending] Integrate with e-commerce platform for real-time data
4. [pending] Build 12-month revenue forecast model
5. [pending] Set up weekly automated cash flow report
6. [pending] Establish monthly P&L review cadence

### P-CFO-2: Financial Reporting Cadence
- **Intention:** INT-CFO-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define report templates (weekly, monthly, quarterly)
2. [pending] Set up automated data collection from all agents
3. [pending] Create stakeholder-facing financial dashboard
4. [pending] Schedule first monthly financial review
`,
    coo: `# Plans — COO

## Active Plans

### P-COO-1: Process Automation Roadmap
- **Intention:** INT-COO-1
- **Template:** PT-004 (Monthly Operations Review)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Inventory all business processes across departments
2. [pending] Classify each process: fully automated / semi-automated / manual
3. [pending] Prioritize automation opportunities by impact and effort
4. [pending] Coordinate with CTO on automation infrastructure
5. [pending] Implement top 5 automation opportunities
6. [pending] Measure automation rate and iterate

### P-COO-2: Fulfillment Pipeline Setup
- **Intention:** INT-COO-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define end-to-end fulfillment workflow with Fulfillment Manager
2. [pending] Establish SLAs for each pipeline stage
3. [pending] Integrate order management with print partner APIs
4. [pending] Set up automated shipping and tracking
5. [pending] Test pipeline with 10 sample orders
`,
    cmo: `# Plans — CMO

## Active Plans

### P-CMO-1: Multi-Channel Marketing Launch
- **Intention:** INT-CMO-1
- **Template:** PB-MKT-001 (Social Media Launch Sequence)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Set up accounts on Instagram, Pinterest, Facebook, TikTok, LinkedIn
2. [pending] Create 30-day content calendar with Creative Director
3. [pending] Publish teaser content (3 posts across platforms)
4. [pending] Launch day: coordinated cross-platform push
5. [pending] Start Meta Ads campaign with $40/day budget
6. [pending] Monitor daily analytics and optimize
7. [pending] Week 2: scale winning content, pause underperformers
8. [pending] Week 4: review ROAS and adjust strategy

### P-CMO-2: Email List Building
- **Intention:** INT-CMO-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Create lead magnet (free art style guide / room design tips)
2. [pending] Build landing page with email capture
3. [pending] Set up email welcome sequence (5 emails)
4. [pending] Integrate email signup across all touchpoints
5. [pending] Run dedicated list-building ads ($10/day)
`,
    cto: `# Plans — CTO

## Active Plans

### P-CTO-1: Monitoring and Alerting Stack
- **Intention:** INT-CTO-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Deploy application performance monitoring (APM)
2. [pending] Set up uptime monitoring for all endpoints
3. [pending] Configure alerting thresholds and escalation
4. [pending] Create runbooks for common incident types
5. [pending] Establish on-call rotation (stakeholder notification)
6. [pending] Test incident response with simulated outage

### P-CTO-2: CI/CD Pipeline Hardening
- **Intention:** INT-CTO-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Audit current deployment pipeline
2. [pending] Add automated test gates (unit, integration)
3. [pending] Implement rollback mechanisms
4. [pending] Set up staging environment for pre-production testing
5. [pending] Document deployment procedures
`,
    hr: `# Plans — HR

## Active Plans

### P-HR-1: Contractor Sourcing Pipeline
- **Intention:** INT-HR-1
- **Template:** PT-003 (New Hire Onboarding)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Identify skill categories needed (design, development, content, print)
2. [pending] Set up profiles on freelance platforms (Upwork, Fiverr, 99designs)
3. [pending] Create job posting templates per category
4. [pending] Screen and shortlist 5+ candidates per category
5. [pending] Coordinate with Legal for contract templates

### P-HR-2: Onboarding Workflow
- **Intention:** INT-HR-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define onboarding checklist per role type
2. [pending] Create workspace access provisioning workflow with CTO
3. [pending] Build documentation package for new contractors
4. [pending] Set up kickoff meeting template
`,
    legal: `# Plans — Legal

## Active Plans

### P-LEGAL-1: GDPR/CCPA Compliance
- **Intention:** INT-LEGAL-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Audit all data collection points (website, email, ads, WhatsApp)
2. [pending] Map data flows and storage locations with CTO
3. [pending] Draft privacy policy (GDPR + CCPA compliant)
4. [pending] Implement data subject rights processes (access, deletion, export)
5. [pending] Set up data processing agreements with vendors
6. [pending] Coordinate with Compliance Director on monitoring

### P-LEGAL-2: Contract Template Library
- **Intention:** INT-LEGAL-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Draft freelancer service agreement
2. [pending] Draft mutual NDA template
3. [pending] Draft customer terms of service
4. [pending] Draft privacy policy
5. [pending] Draft print partner SLA
6. [pending] Review all templates with CEO for approval
`,
    strategy: `# Plans — Strategy

## Active Plans

### P-STRAT-1: Market Capture Roadmap
- **Intention:** INT-STRAT-1
- **Template:** PT-001 (Market Research)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define premium wall art market segments and sizing
2. [pending] Identify key growth drivers and barriers
3. [pending] Map customer journey from awareness to purchase
4. [pending] Define phase-gated market capture milestones
5. [pending] Present roadmap to CEO for approval

### P-STRAT-2: Competitive Landscape Analysis
- **Intention:** INT-STRAT-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Identify top 10 competitors (direct and indirect)
2. [pending] Analyze pricing, positioning, and product range per competitor
3. [pending] SWOT analysis for each competitor
4. [pending] Identify competitive gaps VividWalls can exploit
5. [pending] Synthesize into competitive strategy brief
`,
    knowledge: `# Plans — Knowledge Manager

## Active Plans

### P-KM-1: Business Ontology Build
- **Intention:** INT-KM-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define core business concepts (product, customer, order, etc.)
2. [pending] Map relationships between concepts
3. [pending] Define SBVR business rules for policy enforcement
4. [pending] Load ontology into TypeDB
5. [pending] Validate with domain agents for accuracy

### P-KM-2: CBR Library Seeding
- **Intention:** INT-KM-2
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define case template structure
2. [pending] Seed initial cases from business plan decisions
3. [pending] Set up case ingestion pipeline from agent events
4. [pending] Test case retrieval accuracy
`,
  };

  // Domain agent plans
  const domainPlans: Record<string, string> = {
    "inventory-mgr": `# Plans — Inventory Manager

## Active Plans

### P-INV-1: Print Partner Onboarding
- **Intention:** INT-INV-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Research print-on-demand providers (Printful, Gooten, SPOD)
2. [pending] Request samples from top 3 candidates
3. [pending] Evaluate quality, speed, and pricing
4. [pending] Negotiate terms with selected partners
5. [pending] Coordinate with Legal for SLA contracts
6. [pending] Set up API integration with CTO

### P-INV-2: Product Catalog Build
- **Intention:** INT-INV-2
- **Status:** in_progress
- **Started:** 2026-02-18

#### Steps
1. [pending] Define catalog structure (categories, attributes, variants)
2. [pending] Coordinate with Creative Director for initial 100 designs
3. [pending] Upload designs with metadata (style, colors, dimensions)
4. [pending] Set pricing per size and material with CFO input
`,
    "fulfillment-mgr": `# Plans — Fulfillment Manager

## Active Plans

### P-FUL-1: Pipeline Monitoring & Maintenance
- **Intention:** INT-FUL-1
- **Status:** active
- **Started:** 2026-03-04

#### Steps (recurring)
1. Run \`pictorem_pipeline_stats\` — check error_rate and by_status breakdown
2. If error_rate > 5%: investigate with \`pictorem_queue_list\` (status filter)
3. Review any blocked_no_print_image items — escalate to stakeholder
4. Verify bridge uptime is healthy (> 99%)
5. Generate daily summary for COO

### P-FUL-2: Error Recovery
- **Intention:** INT-FUL-2
- **Status:** active
- **Started:** 2026-03-04

#### Steps (per-error)
1. Identify failed items: \`pictorem_queue_list\` with status=automation_error (etc.)
2. Check specific order: \`pictorem_order_status\` for details
3. If retryable (< 3 retries): \`pictorem_retry_fulfillment\`
4. If retry fails or max retries: escalate to CTO with error details
5. If blocked_no_print_image: notify stakeholder to upload print file
`,
    "product-mgr": `# Plans — Product Manager

## Active Plans

### P-PM-1: Signature Collection Launch
- **Intention:** INT-PM-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Curate 50 best AI-generated art pieces with Creative Director
2. [pending] Define size and material options per piece
3. [pending] Set pricing tiers with CFO
4. [pending] Create product pages with descriptions and mockups
5. [pending] Coordinate launch announcement with CMO
`,
    "marketing-director": `# Plans — Marketing Director

## Active Plans

### P-MKTD-1: Social Media Launch
- **Intention:** INT-MKTD-1
- **Template:** PB-MKT-001 (Social Media Launch Sequence)
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Set up all social media accounts with consistent branding
2. [pending] Create 30-day content calendar
3. [pending] Publish 3 teaser posts before launch
4. [pending] Execute coordinated launch day content
5. [pending] Run $20-50/day engagement campaign
6. [pending] Monitor and adjust daily

### P-MKTD-2: Meta Ads Setup
- **Intention:** INT-MKTD-2
- **Template:** PB-MKT-002 (Meta Ads Scaling)
- **Status:** in_progress
- **Started:** 2026-02-18

#### Steps
1. [pending] Install Meta pixel on storefront
2. [pending] Define target audiences (interests, demographics, lookalikes)
3. [pending] Create 3 ad sets with different creative approaches
4. [pending] Launch with $40/day budget split across ad sets
5. [pending] Optimize daily based on CPA and ROAS
`,
    "sales-director": `# Plans — Sales Director

## Active Plans

### P-SD-1: Persona Deployment
- **Intention:** INT-SD-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Receive persona profiles from CEO
2. [pending] Map each persona to product recommendations
3. [pending] Configure recommendation engine per persona with CTO
4. [pending] Create persona-specific landing pages
5. [pending] Deploy first 3 personas as pilot
6. [pending] Measure conversion per persona for 2 weeks
7. [pending] Roll out remaining 10 personas

### P-SD-2: Checkout Optimization
- **Intention:** INT-SD-2
- **Status:** in_progress
- **Started:** 2026-02-18

#### Steps
1. [pending] Audit current checkout flow for friction points
2. [pending] Implement A/B testing framework with CTO
3. [pending] Test: single-page vs. multi-step checkout
4. [pending] Add trust signals (reviews, guarantees, secure payment badges)
5. [pending] Optimize for mobile conversion
`,
    "compliance-director": `# Plans — Compliance Director

## Active Plans

### P-CD-1: GDPR/CCPA Compliance Audit
- **Intention:** INT-CD-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Create compliance checklist (GDPR + CCPA requirements)
2. [pending] Audit all data collection points on website
3. [pending] Review data storage and processing practices with CTO
4. [pending] Identify compliance gaps
5. [pending] Create remediation plan with timelines
6. [pending] Report findings to Legal agent

### P-CD-2: Cookie Consent Implementation
- **Intention:** INT-CD-2
- **Status:** in_progress
- **Started:** 2026-02-18

#### Steps
1. [pending] Select cookie consent platform
2. [pending] Configure consent categories (necessary, analytics, marketing)
3. [pending] Implement on all pages with CTO
4. [pending] Test consent flows across browsers
`,
    "creative-director": `# Plans — Creative Director

## Active Plans

### P-CRTV-1: Brand Style Guide
- **Intention:** INT-CRTV-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Define color palette, typography, and visual identity
2. [pending] Create logo usage guidelines
3. [pending] Design social media templates (Instagram, Pinterest, Facebook)
4. [pending] Design email templates
5. [pending] Create product photography style guide
6. [pending] Get CEO approval on final style guide

### P-CRTV-2: Content Library Build
- **Intention:** INT-CRTV-2
- **Status:** in_progress
- **Started:** 2026-02-18

#### Steps
1. [pending] Generate 100 AI art pieces across 6 style categories
2. [pending] Create lifestyle mockups (art in room settings)
3. [pending] Design social media content templates
4. [pending] Build ad creative library (5 formats × 4 styles)
5. [pending] Organize assets in shared library with tagging
`,
    "cs-director": `# Plans — Customer Service Director

## Active Plans

### P-CS-1: CS Infrastructure Setup
- **Intention:** INT-CS-1
- **Status:** in_progress
- **Started:** 2026-02-17

#### Steps
1. [pending] Select and configure helpdesk platform
2. [pending] Set up email support channel
3. [pending] Configure live chat widget on storefront
4. [pending] Set up WhatsApp Business for customer engagement
5. [pending] Create response templates for common inquiries
6. [pending] Define SLAs and escalation paths

### P-CS-2: Self-Service Portal
- **Intention:** INT-CS-2
- **Status:** in_progress
- **Started:** 2026-02-18

#### Steps
1. [pending] Build FAQ page with top 20 questions
2. [pending] Implement order tracking self-service
3. [pending] Create returns/exchanges self-service portal
4. [pending] Integrate with Knowledge Manager for content
`,
  };

  return (
    plansByAgent[agentId] || domainPlans[agentId] || `# Plans — ${agentId}\n\n_No active plans._\n`
  );
}

// ── Memory Content ──

function generateMemory(agentId: AgentId): string {
  const displayName = agentId.toUpperCase().replace(/-/g, " ");
  return `# Memory — ${displayName}

## Event Log

### 2026-02-17 — System Initialization
- **Event:** Agent initialized as part of VividWalls MABOS deployment
- **Action:** BDI state created with initial beliefs, desires, and goals
- **Outcome:** Agent operational and ready for goal pursuit

### 2026-02-17 — Goal Adoption
- **Event:** Received delegated goals from Tropos goal model
- **Action:** Adopted goals and created initial intentions
- **Reasoning:** Goals aligned with role responsibilities and stakeholder priorities
- **Outcome:** Active intentions created, plans generated

### 2026-02-17 — Plan Generation
- **Event:** Generated execution plans for active intentions
- **Action:** Decomposed goals into actionable steps using plan templates
- **Reasoning:** Plans follow established templates adapted to VividWalls context
- **Outcome:** Plans in_progress, awaiting execution

### 2026-02-17 — Inter-Agent Coordination
- **Event:** Established communication channels with related agents
- **Action:** Registered message handlers and subscription topics
- **Outcome:** Ready to send/receive agent messages for coordination

## Key Decisions

| Date | Decision | Reasoning | Outcome |
|------|----------|-----------|---------|
| 2026-02-17 | Adopted initial goal set | Aligned with Tropos model delegation | Goals active |
| 2026-02-17 | Prioritized intentions | Based on desire priority scores | Top 2 intentions active |
| 2026-02-17 | Selected plan templates | Best fit for goal types | Plans generated |
`;
}

// ── Knowledge Content ──

function generateKnowledge(agentId: AgentId): string {
  const knowledgeByAgent: Record<string, string> = {
    ceo: `# Knowledge — CEO

## Domain Expertise
- **Business Strategy:** Startup scaling, product-market fit, competitive positioning
- **Leadership:** Multi-agent coordination, stakeholder management, decision frameworks
- **E-commerce:** D2C business models, conversion optimization, customer lifetime value

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Conversion Rate | 3.5%+ | 1.5-3% (e-commerce) |
| CSAT | 90%+ | 75-85% |
| AOV | $75-150 | $50-100 (art prints) |
| Customer Retention | 30%+ | 20-25% |

## Decision Frameworks
- **Strategic decisions:** PT-005 (options analysis + CBR + stakeholder escalation)
- **Resource allocation:** Priority-based using desire hierarchy
- **Conflict resolution:** Priority-based for critical, resource-sharing for growth

## Cross-Agent Dependencies
- Depends on: CFO (financial data), CMO (market data), COO (operational metrics)
- Depended on by: All agents (strategic direction, approvals)
`,
    cfo: `# Knowledge — CFO

## Domain Expertise
- **Financial Planning:** Cash flow forecasting, runway management, budgeting
- **Unit Economics:** CAC, LTV, ROAS, gross margin analysis
- **Reporting:** P&L, balance sheet, financial dashboards

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Gross Margin | 65-70% | 50-60% (POD) |
| CAC | < $25 | $30-50 (e-commerce) |
| LTV:CAC Ratio | > 3:1 | 3:1 (healthy) |
| Monthly Burn Rate | < $5K | Varies |
| Cash Runway | > 6 months | 12+ months (ideal) |

## Financial Models
- Revenue forecast: Bottom-up (traffic × conversion × AOV)
- Cash flow: Weekly rolling 13-week forecast
- Unit economics: Per-order profitability analysis

## Cross-Agent Dependencies
- Depends on: CMO (marketing spend/revenue), COO (operational costs)
- Depended on by: CEO (financial decisions), all agents (budget approvals)
`,
    coo: `# Knowledge — COO

## Domain Expertise
- **Operations Management:** Process design, SLA management, bottleneck analysis
- **Automation:** Workflow automation, RPA, process monitoring
- **Supply Chain:** Print-on-demand fulfillment, logistics coordination

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Automation Rate | 95% | 60-70% |
| Order Processing Time | < 48 hours | 2-5 days |
| On-Time Delivery | > 95% | 90-95% |
| Process Error Rate | < 2% | 3-5% |

## Process Catalog
- Order management (intake → fulfillment → delivery)
- Customer communication pipeline
- Agent coordination and task routing
- Vendor management and quality control
- Performance monitoring and reporting

## Cross-Agent Dependencies
- Depends on: CTO (automation infrastructure), Fulfillment Mgr (execution)
- Depended on by: CEO (operational metrics), all department managers
`,
    cmo: `# Knowledge — CMO

## Domain Expertise
- **Digital Marketing:** Social media, paid ads, content marketing, SEO
- **Brand Building:** Positioning, messaging, visual identity
- **Analytics:** Attribution modeling, funnel analysis, A/B testing

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| ROAS | 15x | 4-6x (e-commerce) |
| Email Open Rate | 25%+ | 20-25% |
| Social Engagement | 3%+ | 1-3% |
| CAC | < $25 | $30-50 |

## Channel Playbooks
- Social media launch: PB-MKT-001
- Meta Ads scaling: PB-MKT-002
- Multi-platform content: PB-MKT-003
- WhatsApp nurture: PB-MKT-004
- Retargeting funnel: PB-MKT-005

## Cross-Agent Dependencies
- Depends on: Creative Director (content), CFO (budget), CTO (tracking)
- Depended on by: CEO (revenue targets), Sales Director (traffic)
`,
    cto: `# Knowledge — CTO

## Domain Expertise
- **System Architecture:** Microservices, event-driven, multi-agent systems
- **DevOps:** CI/CD, monitoring, incident response, infrastructure as code
- **Security:** Authentication, encryption, OWASP Top 10, compliance controls

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Uptime | 99.9% | 99.5-99.9% |
| Page Load Time | < 2s | 2-3s |
| Deployment Frequency | Daily | Weekly |
| MTTR | < 30 min | 1-4 hours |

## Technology Stack
- **Backend:** Node.js/TypeScript, Express
- **Frontend:** React, TailwindCSS
- **Database:** PostgreSQL (transactional), TypeDB (knowledge graph)
- **Infrastructure:** Cloud hosting, CDN, automated backups
- **AI:** Generative art models, NLP for agent reasoning

## Cross-Agent Dependencies
- Depends on: No external dependencies for core infrastructure
- Depended on by: All agents (platform stability, features)
`,
    hr: `# Knowledge — HR

## Domain Expertise
- **Talent Acquisition:** Freelance platforms, contractor sourcing, skill assessment
- **Workforce Management:** Capacity planning, utilization, onboarding
- **Compliance:** Labor law basics, contractor vs. employee classification

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Time to Fill | < 2 weeks | 2-4 weeks |
| Onboarding Time | < 1 week | 1-2 weeks |
| Contractor Satisfaction | 4.5+/5 | 4.0/5 |
| Re-engagement Rate | 70%+ | 50-60% |

## Sourcing Channels
- Upwork: General freelance (design, development, content)
- Fiverr: Quick tasks, logo design, simple graphics
- 99designs: Creative contests for design work
- Direct outreach: Specialized print-on-demand experts
`,
    legal: `# Knowledge — Legal

## Domain Expertise
- **Regulatory Compliance:** GDPR, CCPA, FTC, CAN-SPAM
- **Intellectual Property:** Trademark, copyright (including AI-generated works)
- **Contract Law:** Service agreements, NDAs, terms of service

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Compliance Score | 100% | 90-95% |
| Contract Turnaround | < 48 hours | 3-5 days |
| Legal Issue Resolution | < 1 week | 2-4 weeks |

## Regulatory Calendar
- GDPR: Ongoing compliance, annual DPA review
- CCPA: Annual privacy policy update
- Trademark: File within Q1 2026, expect 8-12 month process
- Tax: Quarterly estimated taxes, annual filing
`,
    strategy: `# Knowledge — Strategy

## Domain Expertise
- **Strategic Analysis:** Porter's Five Forces, SWOT, competitive benchmarking
- **Market Intelligence:** TAM/SAM/SOM sizing, trend analysis, scenario planning
- **Growth Strategy:** Market penetration, product development, diversification

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Market Share | 15% (premium) | N/A (new entrant) |
| Revenue Growth | 10x Year 1→2 | 2-3x (e-commerce) |
| Brand Awareness | Top 5 AI art | N/A (emerging) |

## Strategic Frameworks
- Phase-gated growth model (PMF → Scale → Expand)
- Competitive moat analysis (curation quality, brand, data)
- Scenario planning for market shifts (AI regulation, competition)
`,
    knowledge: `# Knowledge — Knowledge Manager

## Domain Expertise
- **Ontology Engineering:** Concept modeling, relationship mapping, SBVR rules
- **Knowledge Management:** Taxonomy, tagging, retrieval, curation
- **Reasoning Systems:** Case-based reasoning, inference engines, proof tables

## Key Metrics & Benchmarks
| Metric | VividWalls Target | Industry Benchmark |
|--------|------------------|-------------------|
| Ontology Coverage | 80% concepts | N/A |
| CBR Case Count | 50+ | N/A |
| Knowledge Freshness | < 5% stale | 10-20% |
| Retrieval Accuracy | 90%+ | 80% |

## Knowledge Architecture
- TypeDB for ontology graph and relationship queries
- SBVR rules for business policy enforcement
- Case-based reasoning library for decision support
- BDI state management per agent (beliefs, desires, goals, etc.)
`,
  };

  const domainKnowledge: Record<string, string> = {
    "inventory-mgr": `# Knowledge — Inventory Manager

## Domain Expertise
- **Print-on-Demand:** Provider evaluation, quality standards, production workflows
- **Catalog Management:** SKU structure, product variants, pricing models
- **Supply Chain:** Vendor relationships, material sourcing, quality control

## Key Metrics
| Metric | Target |
|--------|--------|
| Print Defect Rate | < 2% |
| Catalog Size | 500+ designs |
| Supplier Lead Time | < 3 days |
| Material Cost per Unit | Optimize quarterly |
`,
    "fulfillment-mgr": `# Knowledge — Fulfillment Manager

## Tools Reference
| Tool | Purpose | When to Use |
|------|---------|-------------|
| pictorem_pipeline_stats | Dashboard: counts, error rate, uptime | Daily health check, reporting |
| pictorem_queue_list | List/filter queue items by status | Investigating issues, auditing |
| pictorem_order_status | Detailed status for one order | Customer inquiry, debugging |
| pictorem_retry_fulfillment | Retry failed items | After transient errors |
| pictorem_trigger_fulfillment | Manual trigger for an order | Re-run missed orders |

## Error Triage Matrix
| Error Status | Likely Cause | Action |
|-------------|-------------|--------|
| image_download_failed | Image URL expired or unreachable | Retry (often transient) |
| automation_error | Pictorem UI changed or CDP crash | Retry once, then escalate to CTO |
| automation_partial | CDP completed some steps but not all | Check order on Pictorem manually |
| submission_failed | Network/timeout during submission | Retry (usually transient) |
| blocked_no_print_image | No print-ready file in database | Notify stakeholder to upload |

## Key Metrics
| Metric | Target | Tool |
|--------|--------|------|
| Auto-fulfillment Rate | > 95% | pictorem_pipeline_stats |
| Error Rate | < 5% | pictorem_pipeline_stats |
| Retry Resolution | < 20 min | pictorem_order_status |
| Bridge Uptime | > 99% | pictorem_pipeline_stats |
`,
    "product-mgr": `# Knowledge — Product Manager

## Domain Expertise
- **Product Strategy:** Roadmap planning, feature prioritization, market fit
- **E-commerce UX:** Product pages, checkout optimization, personalization
- **Art Curation:** Quality scoring, collection theming, customer preferences

## Key Metrics
| Metric | Target |
|--------|--------|
| Conversion Rate | 3.5%+ |
| AOV | $75-150 |
| Product Page Bounce | < 40% |
| Collection Performance | Track per collection |
`,
    "marketing-director": `# Knowledge — Marketing Director

## Domain Expertise
- **Campaign Management:** Meta Ads, Pinterest Ads, content scheduling
- **Social Media:** Platform-specific strategies, engagement tactics
- **Analytics:** Attribution, UTM tracking, funnel analysis

## Key Metrics
| Metric | Target |
|--------|--------|
| ROAS | 15x |
| Engagement Rate | 3%+ |
| Content Publish Rate | 5+/week |
| Follower Growth | 10K in 90 days |
`,
    "sales-director": `# Knowledge — Sales Director

## Domain Expertise
- **Conversion Optimization:** A/B testing, checkout flows, trust signals
- **Sales Psychology:** Persona-based selling, ethical persuasion
- **E-commerce Analytics:** Funnel analysis, cart abandonment, upselling

## Key Metrics
| Metric | Target |
|--------|--------|
| Conversion Rate | 3.5%+ |
| Cart Abandonment | < 65% |
| AOV | $75-150 |
| Persona Effectiveness | Track per persona |
`,
    "compliance-director": `# Knowledge — Compliance Director

## Domain Expertise
- **Privacy Regulations:** GDPR, CCPA, cookie consent, data subject rights
- **E-commerce Compliance:** FTC guidelines, PCI-DSS, advertising standards
- **Audit Methodology:** Gap analysis, remediation planning, ongoing monitoring

## Key Metrics
| Metric | Target |
|--------|--------|
| Compliance Score | 100% |
| Cookie Consent Rate | > 60% |
| DSR Response Time | < 30 days |
| Audit Frequency | Monthly |
`,
    "creative-director": `# Knowledge — Creative Director

## Domain Expertise
- **Brand Design:** Visual identity, style guides, design systems
- **Content Creation:** Photography direction, social media design, ad creative
- **AI Art Curation:** Quality assessment, style consistency, print reproduction

## Key Metrics
| Metric | Target |
|--------|--------|
| Content Library Size | 200+ assets |
| Brand Consistency Score | 95%+ |
| Ad Creative Performance | Track CTR per creative |
| Art Quality Score | > 8/10 |
`,
    "cs-director": `# Knowledge — Customer Service Director

## Domain Expertise
- **Customer Support:** Multi-channel support, ticket management, escalation
- **CSAT Management:** Survey design, NPS tracking, service recovery
- **Self-Service:** FAQ management, knowledge base, automated responses

## Key Metrics
| Metric | Target |
|--------|--------|
| CSAT | 90%+ |
| First Response Time | < 4 hours |
| Resolution Time | < 24 hours |
| Self-Service Rate | 50%+ |
`,
  };

  return (
    knowledgeByAgent[agentId] ||
    domainKnowledge[agentId] ||
    `# Knowledge — ${agentId}\n\n_Domain knowledge to be populated._\n`
  );
}

// ── Playbooks Content ──

function generatePlaybooks(agentId: AgentId): string {
  const playbooksByAgent: Record<string, string> = {
    ceo: `# Playbooks — CEO

## PB-CEO-1: Strategic Decision Escalation
**Trigger:** Decision with >$1K impact or cross-department scope
1. Gather input from relevant C-suite agents
2. Apply PT-005 (Strategic Decision Framework)
3. Check CBR for analogous past decisions
4. Present options with impact analysis to stakeholder
5. Execute chosen option and log decision in Memory

## PB-CEO-2: Agent Performance Review
**Trigger:** Monthly or when KPIs miss target by >20%
1. Collect KPIs from all agents via QUERY messages
2. Compare against targets and previous period
3. Identify underperforming areas
4. Coordinate remediation plans with relevant agents
5. Escalate structural issues to stakeholder
`,
    cfo: `# Playbooks — CFO

## PB-CFO-1: Weekly Cash Flow Review
**Trigger:** Every Monday
1. Pull revenue data from e-commerce platform
2. Aggregate expenses by category
3. Calculate burn rate and runway
4. Flag any anomalies (>15% variance from forecast)
5. Update financial dashboard
6. Escalate if runway < 6 months

## PB-CFO-2: Marketing Spend Approval
**Trigger:** CMO requests budget change
1. Review current ROAS and CAC metrics
2. Assess budget impact on cash runway
3. If within $2K cap: approve and log
4. If exceeds cap: escalate to stakeholder with recommendation
`,
    coo: `# Playbooks — COO

## PB-COO-1: Incident Response
**Trigger:** System alert or process failure
1. Assess severity (P1-critical, P2-major, P3-minor)
2. Notify CTO for system issues, relevant manager for process issues
3. Coordinate resolution across agents
4. Post-mortem: document root cause and prevention measures
5. Update process documentation

## PB-COO-2: Monthly Operations Review
**Trigger:** First Monday of each month
1. Collect KPIs from all department managers
2. Review automation rate progress
3. Identify bottlenecks and improvement opportunities
4. Present operational health report to CEO
`,
    cmo: `# Playbooks — CMO

## PB-MKT-001: Social Media Launch Sequence
**Trigger:** New business or product launch
1. Set up platform accounts
2. Create content calendar for first 30 days
3. Publish teaser content — 3 posts across platforms
4. Launch day: coordinated cross-platform push
5. Run engagement campaign — $20-50/day
6. Monitor daily analytics
7. Week 2: scale winning content, pause underperformers
8. Week 4: review and store case

## PB-MKT-002: Meta Ads Scaling Playbook
**Trigger:** Campaign with ROAS > 2x for 3+ days
1. Duplicate winning ad set
2. Increase budget 20% on original
3. Create lookalike audience from converters
4. Test new ad set with lookalike audience
5. Monitor CPA for 48 hours
6. Scale or pause based on CPA vs. target

## PB-MKT-003: Multi-Platform Content Distribution
**Trigger:** New content piece ready
1. Adapt content for each platform format
2. Schedule staggered publishing
3. Publish to all platforms
4. Monitor engagement for 24 hours
5. Boost top performer with $10-20

## PB-MKT-004: WhatsApp Business Nurture Sequence
**Trigger:** New lead or customer
1. Day 0: Welcome template message
2. Day 1: Value-add content
3. Day 3: Interactive check-in with buttons
4. Day 7: Offer/promotion with CTA
5. Day 14: Feedback request

## PB-MKT-005: Retargeting Funnel
**Trigger:** Website traffic > 1000 visitors/month
1. Create website visitor audience (30 day)
2. Create lookalike from customers (1%)
3. Top of funnel: awareness to lookalike ($15/day)
4. Middle: retarget visitors with social proof ($10/day)
5. Bottom: retarget cart abandoners with offer ($5/day)
`,
    cto: `# Playbooks — CTO

## PB-CTO-1: Incident Response
**Trigger:** System alert (uptime, error rate, latency)
1. Acknowledge alert within 5 minutes
2. Assess impact and severity
3. If P1: all-hands response, notify COO and CEO
4. Apply runbook for known issue types
5. If unknown: investigate, isolate, mitigate
6. Post-mortem within 24 hours

## PB-CTO-2: Deployment Playbook
**Trigger:** Code ready for production
1. Run full test suite (unit + integration)
2. Deploy to staging, verify in staging environment
3. Deploy to production with feature flags if applicable
4. Monitor error rates and performance for 30 minutes
5. Rollback if error rate > 1% or latency > 3x baseline
`,
    hr: `# Playbooks — HR

## PB-HR-1: Contractor Engagement
**Trigger:** New skill need identified by any agent
1. Define work package scope and budget with requesting agent
2. Source candidates from platform pipeline
3. Screen top 3-5 candidates (portfolio, references)
4. Coordinate contract with Legal
5. Execute contract and NDA
6. Onboard per P-HR-2 workflow
7. Kickoff meeting and expectations alignment

## PB-HR-2: Contractor Offboarding
**Trigger:** Contract completion or termination
1. Final deliverables review and acceptance
2. Revoke system access with CTO
3. Process final payment with CFO
4. Collect feedback (satisfaction survey)
5. Update contractor database
`,
    legal: `# Playbooks — Legal

## PB-LEGAL-1: Contract Review
**Trigger:** New contract or agreement needed
1. Select appropriate template
2. Customize for specific engagement
3. Review risk factors (liability, IP, termination)
4. Send for counterparty review
5. Negotiate any requested changes
6. Execute and file

## PB-LEGAL-2: Compliance Incident Response
**Trigger:** Potential compliance violation detected
1. Assess severity and scope of violation
2. Contain: stop the violating process/activity
3. Document: capture evidence and timeline
4. Remediate: fix the underlying issue
5. Report: notify stakeholder if material
6. Prevent: update policies/controls to prevent recurrence
`,
    strategy: `# Playbooks — Strategy

## PB-STRAT-1: Quarterly Strategy Review
**Trigger:** End of each quarter
1. Collect performance data from all C-suite agents
2. Review progress against strategic milestones
3. Update competitive landscape analysis
4. Identify strategic pivots or adjustments needed
5. Present strategy update to CEO and stakeholder
6. Update OKRs for next quarter

## PB-STRAT-2: Competitive Response
**Trigger:** New competitor entry or competitor strategic move
1. Analyze competitor action and potential impact
2. Assess VividWalls competitive position
3. Identify response options (ignore, match, differentiate, pre-empt)
4. Recommend response to CEO
5. Coordinate execution across relevant agents
`,
    knowledge: `# Playbooks — Knowledge Manager

## PB-KM-1: Knowledge Audit
**Trigger:** Monthly or when >10% of queries return no results
1. Review knowledge retrieval accuracy metrics
2. Identify stale or incorrect entries
3. Flag knowledge gaps from agent queries
4. Prioritize corrections and additions
5. Update ontology and CBR library
6. Report knowledge health metrics

## PB-KM-2: Case Ingestion
**Trigger:** Significant business decision or outcome
1. Capture decision context (situation, options, chosen action)
2. Record outcome and lessons learned
3. Tag with relevant ontology concepts
4. Store in CBR library
5. Index for future retrieval
`,
  };

  const domainPlaybooks: Record<string, string> = {
    "inventory-mgr": `# Playbooks — Inventory Manager

## PB-INV-1: New Product Onboarding
**Trigger:** New art design approved for catalog
1. Create SKU with size/material variants
2. Upload print files to partner
3. Order test print for quality verification
4. Set pricing with CFO input
5. Create product listing with metadata
6. Notify Product Manager for storefront publish

## PB-INV-2: Supplier Issue Escalation
**Trigger:** Print defect rate > 2% or lead time > SLA
1. Document issue with evidence
2. Contact supplier for resolution
3. If unresolved in 48h: escalate to COO
4. Activate backup supplier if needed
`,
    "fulfillment-mgr": `# Playbooks — Fulfillment Manager

## PB-FUL-1: Daily Pipeline Health Check
**Trigger:** Daily (morning) or on-demand
1. Run \`pictorem_pipeline_stats\`
2. Check error_rate — if > 5%, proceed to PB-FUL-2
3. Check by_status for any blocked_no_print_image items → notify stakeholder
4. Verify bridge uptime looks healthy
5. Summarize status for COO: total orders, success rate, any issues

## PB-FUL-2: Error Recovery
**Trigger:** Error rate > 5% or specific order failure reported
1. Run \`pictorem_queue_list\` with status filter for error statuses
2. For each failed item: \`pictorem_order_status\` to get details
3. If retryable and retry_count < 3: \`pictorem_retry_fulfillment\`
4. Wait 2-3 minutes, then check \`pictorem_order_status\` again
5. If still failing after 3 retries: escalate to CTO with full error details

## PB-FUL-3: New Order Verification
**Trigger:** After a new order is placed (ad-hoc check)
1. \`pictorem_order_status\` with the order number
2. If status is submitted_to_pictorem: all good
3. If status is an error: run PB-FUL-2
4. If no items found: \`pictorem_trigger_fulfillment\` to manually trigger

## PB-FUL-4: Weekly Report
**Trigger:** Weekly (Friday)
1. Run \`pictorem_pipeline_stats\` for totals
2. Run \`pictorem_queue_list\` with limit=100 for recent activity
3. Calculate: success rate, avg retry count, common error types
4. Format report for COO and stakeholder
`,
    "product-mgr": `# Playbooks — Product Manager

## PB-PM-1: Collection Launch
**Trigger:** New collection curated and approved
1. Finalize product selection with Creative Director
2. Set pricing and variants with CFO
3. Create product pages with descriptions
4. Coordinate marketing announcement with CMO
5. Launch and monitor initial sales performance
6. Iterate based on first-week data

## PB-PM-2: Product Performance Review
**Trigger:** Weekly
1. Review sales by product, collection, and category
2. Identify top sellers and underperformers
3. Recommend promotions for slow movers
4. Suggest new products based on trends
`,
    "marketing-director": `# Playbooks — Marketing Director

## PB-MKTD-1: Campaign Launch
**Trigger:** New campaign approved by CMO
1. Brief Creative Director on asset needs
2. Set up campaign in ad platform
3. Configure tracking (UTMs, pixels, events)
4. Launch and monitor for first 24 hours
5. Optimize daily: pause losers, scale winners
6. Weekly report to CMO with metrics

## PB-MKTD-2: Content Calendar Execution
**Trigger:** Weekly
1. Review upcoming content calendar
2. Confirm assets ready with Creative Director
3. Schedule posts across platforms
4. Monitor engagement and respond to comments
5. Report weekly engagement metrics
`,
    "sales-director": `# Playbooks — Sales Director

## PB-SD-1: Persona A/B Testing
**Trigger:** New persona deployed
1. Set up A/B test (persona vs. control)
2. Run for minimum 1,000 visitors per variant
3. Measure conversion rate, AOV, and revenue per visitor
4. If persona wins: deploy fully
5. If control wins: refine persona and re-test

## PB-SD-2: Cart Abandonment Recovery
**Trigger:** Cart abandonment detected
1. Send abandonment email within 1 hour
2. Include product images and compelling copy
3. Day 2: follow-up with social proof
4. Day 3: offer small incentive if applicable
5. Track recovery rate per sequence
`,
    "compliance-director": `# Playbooks — Compliance Director

## PB-CD-1: Data Subject Request Handling
**Trigger:** Customer data access/deletion request
1. Verify requester identity
2. Locate all personal data across systems
3. For access: compile and deliver within 30 days
4. For deletion: remove data, confirm within 30 days
5. Log request and resolution in compliance register

## PB-CD-2: New Feature Compliance Review
**Trigger:** New feature or data collection point proposed
1. Review data collection requirements
2. Assess privacy impact (GDPR DPIA if needed)
3. Ensure consent mechanisms in place
4. Approve or require modifications before launch
`,
    "creative-director": `# Playbooks — Creative Director

## PB-CRTV-1: Art Curation Pipeline
**Trigger:** New AI-generated art batch ready
1. Review against quality criteria (aesthetic, print quality, style)
2. Score each piece (1-10 scale)
3. Accept pieces scoring > 8
4. Assign to collections based on style
5. Create lifestyle mockups
6. Send to Product Manager for catalog

## PB-CRTV-2: Brand Asset Request
**Trigger:** Agent requests creative asset
1. Understand asset requirements and use case
2. Create or adapt from existing templates
3. Ensure brand guideline compliance
4. Deliver asset with usage guidelines
5. Add to shared asset library
`,
    "cs-director": `# Playbooks — Customer Service Director

## PB-CS-1: Customer Complaint Escalation
**Trigger:** Customer complaint or negative feedback
1. Acknowledge within 2 hours
2. Assess issue severity (product, shipping, billing)
3. Resolve if within authority (refund < $50, replacement)
4. Escalate to relevant department if needed
5. Follow up with customer within 24 hours
6. Log for quality review and pattern analysis

## PB-CS-2: CSAT Recovery
**Trigger:** CSAT drops below 85% for a week
1. Analyze recent tickets for common themes
2. Identify root cause (product, fulfillment, response time)
3. Coordinate with responsible department
4. Implement immediate improvements
5. Monitor CSAT daily until recovered above 90%
6. Report recovery plan and progress to CEO
`,
  };

  return (
    playbooksByAgent[agentId] ||
    domainPlaybooks[agentId] ||
    `# Playbooks — ${agentId}\n\n_Operational playbooks to be defined._\n`
  );
}

// ── Main Execution ──

function main() {
  console.log("BDI Content Seed — VividWalls");
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Agents dir: ${AGENTS_DIR}`);
  console.log(`Templates dir: ${TEMPLATES_DIR}`);
  console.log("");

  for (const agentId of ALL_AGENTS) {
    console.log(`Seeding ${agentId}...`);

    try {
      // 1. Beliefs
      writeFile(agentId, "Beliefs.md", beliefs[agentId]);
      fileCount++;

      // 2. Desires — from templates for core agents, generated for domain
      const coreRole = CORE_AGENTS.includes(agentId as any) ? agentId : null;
      let desiresContent: string;
      if (coreRole) {
        const template = readTemplate(coreRole);
        if (template) {
          desiresContent = template.replace("(Template)", `— VividWalls`);
        } else {
          desiresContent = `# Desires — ${agentId.toUpperCase()}\n\n_Desire template not found for role: ${coreRole}_\n`;
        }
      } else {
        // Generate desires for domain agents based on their department
        const domainDesires: Record<string, string> = {
          "inventory-mgr": `# Desires — Inventory Manager (VividWalls)

## Terminal Desires

### D-001: Catalog Completeness
- **Description:** Maintain a comprehensive, high-quality product catalog
- **Type:** optimize
- **Priority Score:** 0.90
- **Generates Goals:** Catalog growth, quality standards, variety targets

### D-002: Supplier Reliability
- **Description:** Ensure print partners consistently meet quality and delivery SLAs
- **Type:** maintain
- **Priority Score:** 0.85
- **Generates Goals:** Partner evaluation, SLA monitoring, backup sourcing

## Instrumental Desires

### D-010: Cost Efficiency
- **Serves:** D-001
- **Description:** Optimize material and production costs per unit
- **Type:** optimize
- **Priority Score:** 0.65

## Desire Hierarchy
1. D-001: Catalog Completeness — 0.90
2. D-002: Supplier Reliability — 0.85
3. D-010: Cost Efficiency — 0.65
`,
          "fulfillment-mgr": `# Desires — Fulfillment Manager (VividWalls)

## Terminal Desires

### D-001: Pipeline Reliability
- **Description:** Every paid order auto-fulfilled through Pictorem without manual intervention
- **Type:** maintain
- **Priority Score:** 0.95
- **Generates Goals:** G-FUL-1 (auto-fulfillment rate), G-FUL-2 (error rate)
- **Tools:** pictorem_pipeline_stats, pictorem_queue_list

### D-002: Fulfillment Speed
- **Description:** Minimize time from Shopify payment to Pictorem submission
- **Type:** optimize
- **Priority Score:** 0.85
- **Generates Goals:** G-FUL-3 (retry resolution time)
- **Tools:** pictorem_order_status, pictorem_retry_fulfillment

## Instrumental Desires

### D-010: Error Recovery Mastery
- **Serves:** D-001, D-002
- **Description:** Quickly identify, retry, and resolve pipeline failures
- **Type:** optimize
- **Priority Score:** 0.78
- **Tools:** pictorem_retry_fulfillment, pictorem_trigger_fulfillment

## Desire Hierarchy
1. D-001: Pipeline Reliability — 0.95
2. D-002: Fulfillment Speed — 0.85
3. D-010: Error Recovery Mastery — 0.78
`,
          "product-mgr": `# Desires — Product Manager (VividWalls)

## Terminal Desires

### D-001: Product-Market Fit
- **Description:** Products that customers love and want to buy
- **Type:** optimize
- **Priority Score:** 0.91
- **Generates Goals:** Conversion optimization, product curation, customer feedback

### D-002: Revenue per Product
- **Description:** Maximize revenue contribution per SKU
- **Type:** optimize
- **Priority Score:** 0.84
- **Generates Goals:** Pricing optimization, upsell strategies, bundle design

## Instrumental Desires

### D-010: Customer Insights
- **Serves:** D-001
- **Description:** Maintain deep understanding of customer preferences
- **Type:** maintain
- **Priority Score:** 0.66

## Desire Hierarchy
1. D-001: Product-Market Fit — 0.91
2. D-002: Revenue per Product — 0.84
3. D-010: Customer Insights — 0.66
`,
          "marketing-director": `# Desires — Marketing Director (VividWalls)

## Terminal Desires

### D-001: Campaign Performance
- **Description:** Every campaign meets or exceeds ROAS targets
- **Type:** optimize
- **Priority Score:** 0.90
- **Generates Goals:** ROAS optimization, audience targeting, creative testing

### D-002: Audience Growth
- **Description:** Continuously grow engaged audience across channels
- **Type:** optimize
- **Priority Score:** 0.85
- **Generates Goals:** Follower growth, engagement rate, email list growth

## Instrumental Desires

### D-010: Content Pipeline
- **Serves:** D-001, D-002
- **Description:** Maintain steady flow of quality content for all channels
- **Type:** maintain
- **Priority Score:** 0.67

## Desire Hierarchy
1. D-001: Campaign Performance — 0.90
2. D-002: Audience Growth — 0.85
3. D-010: Content Pipeline — 0.67
`,
          "sales-director": `# Desires — Sales Director (VividWalls)

## Terminal Desires

### D-001: Conversion Excellence
- **Description:** Maximize visitor-to-customer conversion rate
- **Type:** optimize
- **Priority Score:** 0.92
- **Generates Goals:** Conversion rate optimization, checkout improvement, persona deployment

### D-002: Revenue Maximization
- **Description:** Increase revenue per visitor through AOV and upselling
- **Type:** optimize
- **Priority Score:** 0.85
- **Generates Goals:** AOV targets, cross-sell, bundle strategies

## Instrumental Desires

### D-010: Customer Journey Optimization
- **Serves:** D-001
- **Description:** Remove friction from discovery to purchase
- **Type:** optimize
- **Priority Score:** 0.68

## Desire Hierarchy
1. D-001: Conversion Excellence — 0.92
2. D-002: Revenue Maximization — 0.85
3. D-010: Customer Journey Optimization — 0.68
`,
          "compliance-director": `# Desires — Compliance Director (VividWalls)

## Terminal Desires

### D-001: Regulatory Compliance
- **Description:** 100% compliance with all applicable regulations
- **Type:** maintain
- **Priority Score:** 0.95
- **Generates Goals:** GDPR/CCPA compliance, FTC compliance, PCI-DSS

### D-002: Risk Prevention
- **Description:** Proactively identify and prevent compliance risks
- **Type:** maintain
- **Priority Score:** 0.87
- **Generates Goals:** Compliance monitoring, audit cycles, policy updates

## Instrumental Desires

### D-010: Compliance Awareness
- **Serves:** D-001
- **Description:** All agents understand and follow compliance requirements
- **Type:** maintain
- **Priority Score:** 0.64

## Desire Hierarchy
1. D-001: Regulatory Compliance — 0.95
2. D-002: Risk Prevention — 0.87
3. D-010: Compliance Awareness — 0.64
`,
          "creative-director": `# Desires — Creative Director (VividWalls)

## Terminal Desires

### D-001: Brand Excellence
- **Description:** Maintain a premium, consistent brand across all touchpoints
- **Type:** maintain
- **Priority Score:** 0.91
- **Generates Goals:** Brand guidelines, visual consistency, creative quality

### D-002: Creative Output
- **Description:** Produce high-quality creative assets at required volume
- **Type:** optimize
- **Priority Score:** 0.85
- **Generates Goals:** Content library growth, asset turnaround time

## Instrumental Desires

### D-010: Art Curation Quality
- **Serves:** D-001, D-002
- **Description:** Curate only the highest quality AI-generated art
- **Type:** maintain
- **Priority Score:** 0.70

## Desire Hierarchy
1. D-001: Brand Excellence — 0.91
2. D-002: Creative Output — 0.85
3. D-010: Art Curation Quality — 0.70
`,
          "cs-director": `# Desires — Customer Service Director (VividWalls)

## Terminal Desires

### D-001: Customer Satisfaction
- **Description:** Every customer interaction leaves a positive impression
- **Type:** maintain
- **Priority Score:** 0.93
- **Generates Goals:** CSAT targets, response time SLAs, resolution quality

### D-002: Service Efficiency
- **Description:** Resolve customer issues quickly and cost-effectively
- **Type:** optimize
- **Priority Score:** 0.84
- **Generates Goals:** Self-service rate, first-contact resolution, cost per ticket

## Instrumental Desires

### D-010: Knowledge Base Quality
- **Serves:** D-001, D-002
- **Description:** Maintain accurate, helpful self-service content
- **Type:** maintain
- **Priority Score:** 0.66

## Desire Hierarchy
1. D-001: Customer Satisfaction — 0.93
2. D-002: Service Efficiency — 0.84
3. D-010: Knowledge Base Quality — 0.66
`,
        };
        desiresContent =
          domainDesires[agentId] || `# Desires — ${agentId}\n\n_Desires to be defined._\n`;
      }
      writeFile(agentId, "Desires.md", desiresContent);
      fileCount++;

      // 3. Goals
      writeFile(agentId, "Goals.md", generateGoals(agentId));
      fileCount++;

      // 4. Intentions
      writeFile(agentId, "Intentions.md", generateIntentions(agentId));
      fileCount++;

      // 5. Plans
      writeFile(agentId, "Plans.md", generatePlans(agentId));
      fileCount++;

      // 6. Memory
      writeFile(agentId, "Memory.md", generateMemory(agentId));
      fileCount++;

      // 7. Knowledge
      writeFile(agentId, "Knowledge.md", generateKnowledge(agentId));
      fileCount++;

      // 8. Playbooks
      writeFile(agentId, "Playbooks.md", generatePlaybooks(agentId));
      fileCount++;
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
      errorCount++;
    }
  }

  console.log("");
  console.log(`Done! Files written: ${fileCount}, Errors: ${errorCount}`);
}

main();
