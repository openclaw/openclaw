/**
 * MABOS Dashboard — Data Constants & Industry Prefills
 * Must be loaded first — initializes window.MABOS namespace
 */

window.MABOS = {};

MABOS.BUSINESS_TYPES = [
  { id: "ecommerce", label: "E-Commerce" },
  { id: "saas", label: "SaaS" },
  { id: "consulting", label: "Consulting" },
  { id: "marketplace", label: "Marketplace" },
  { id: "retail", label: "Retail" },
  { id: "other", label: "Other" },
];

MABOS.BUSINESS_STAGES = [
  { id: "idea", label: "Idea" },
  { id: "mvp", label: "MVP" },
  { id: "growth", label: "Growth" },
  { id: "scale", label: "Scale" },
  { id: "mature", label: "Mature" },
];

MABOS.LEGAL_STRUCTURES = [
  { id: "sole_proprietorship", label: "Sole Proprietorship", org: "individual" },
  { id: "llc", label: "LLC", org: "limited_liability" },
  { id: "corporation", label: "Corporation", org: "corporate" },
  { id: "partnership", label: "Partnership", org: "partnership" },
  { id: "nonprofit", label: "Nonprofit", org: "nonprofit" },
];

MABOS.CORE_AGENT_ROLES = [
  "ceo",
  "cfo",
  "coo",
  "cmo",
  "cto",
  "hr",
  "legal",
  "strategy",
  "knowledge",
];

MABOS.DOMAIN_AGENTS = {
  ecommerce: [
    {
      id: "inventory-mgr",
      name: "Inventory Manager",
      role: "Manages stock levels, reorder points, and supplier relationships",
    },
    {
      id: "fulfillment-mgr",
      name: "Fulfillment Manager",
      role: "Handles order processing, shipping, and returns",
    },
    {
      id: "product-mgr",
      name: "Product Manager",
      role: "Manages product catalog, pricing, and listings",
    },
  ],
  saas: [
    {
      id: "devops",
      name: "DevOps Engineer",
      role: "Manages deployments, monitoring, uptime, and infrastructure",
    },
    {
      id: "product-mgr",
      name: "Product Manager",
      role: "Manages feature roadmap, user research, and releases",
    },
    {
      id: "customer-success",
      name: "Customer Success",
      role: "Manages onboarding, retention, and churn prevention",
    },
  ],
  consulting: [
    {
      id: "engagement-mgr",
      name: "Engagement Manager",
      role: "Manages client engagements, milestones, and deliverables",
    },
    {
      id: "biz-dev",
      name: "Business Development",
      role: "Manages pipeline, proposals, and client acquisition",
    },
  ],
  marketplace: [
    {
      id: "supply-mgr",
      name: "Supply Manager",
      role: "Manages seller onboarding, quality, and trust scoring",
    },
    {
      id: "demand-mgr",
      name: "Demand Manager",
      role: "Manages buyer acquisition, matching, and experience",
    },
    {
      id: "trust-safety",
      name: "Trust & Safety",
      role: "Manages disputes, fraud prevention, and platform integrity",
    },
  ],
  retail: [
    {
      id: "store-mgr",
      name: "Store Manager",
      role: "Manages store operations, staff scheduling, and customer experience",
    },
    {
      id: "merchandiser",
      name: "Merchandiser",
      role: "Manages product placement, promotions, and visual merchandising",
    },
  ],
};

MABOS.INDUSTRY_PREFILLS = {
  ecommerce: {
    description:
      "Online retail business selling products directly to consumers through a digital storefront.",
    goals: [
      "Achieve $500K annual revenue",
      "Reach 10,000 monthly active customers",
      "Maintain 95% order fulfillment rate",
      "Reduce customer acquisition cost below $25",
    ],
    customer_segments: [
      "Online shoppers",
      "Price-conscious consumers",
      "Repeat buyers",
      "Gift purchasers",
    ],
    value_propositions: [
      "Curated product selection",
      "Competitive pricing",
      "Fast shipping",
      "Easy returns",
    ],
    revenue_streams: ["Product sales", "Shipping fees", "Upsells and cross-sells"],
    products_services: ["Physical products", "Digital products", "Subscription boxes"],
  },
  saas: {
    description:
      "Software-as-a-Service platform providing cloud-based tools to businesses or consumers.",
    goals: [
      "Reach $1M ARR",
      "Achieve 5% monthly growth rate",
      "Maintain churn below 3%",
      "Reach 1,000 paying customers",
    ],
    customer_segments: [
      "Small businesses",
      "Mid-market companies",
      "Enterprise teams",
      "Individual professionals",
    ],
    value_propositions: [
      "Time savings through automation",
      "Real-time collaboration",
      "Data-driven insights",
      "Seamless integrations",
    ],
    revenue_streams: [
      "Monthly subscriptions",
      "Annual contracts",
      "Usage-based pricing",
      "Enterprise licenses",
    ],
    products_services: ["Web application", "API access", "Mobile app", "Premium support"],
  },
  consulting: {
    description:
      "Professional services firm providing expert advice and implementation support to clients.",
    goals: [
      "Achieve 80% client retention rate",
      "Grow revenue 25% year-over-year",
      "Maintain 60%+ profit margins",
      "Build 5 reusable frameworks",
    ],
    customer_segments: [
      "C-suite executives",
      "Department heads",
      "Startup founders",
      "Government agencies",
    ],
    value_propositions: [
      "Deep domain expertise",
      "Proven methodologies",
      "Measurable outcomes",
      "Knowledge transfer",
    ],
    revenue_streams: [
      "Project-based fees",
      "Retainer agreements",
      "Training workshops",
      "Advisory services",
    ],
    products_services: [
      "Strategy consulting",
      "Implementation support",
      "Training programs",
      "Audit services",
    ],
  },
  marketplace: {
    description:
      "Two-sided platform connecting buyers and sellers, facilitating transactions and building trust.",
    goals: [
      "Reach 10,000 active listings",
      "Achieve $2M GMV",
      "Maintain 4.5+ average seller rating",
      "Reduce dispute rate below 2%",
    ],
    customer_segments: [
      "Individual sellers",
      "Small businesses",
      "Bargain hunters",
      "Quality seekers",
    ],
    value_propositions: [
      "Wide selection",
      "Trust and safety",
      "Competitive prices",
      "Convenient transactions",
    ],
    revenue_streams: ["Transaction fees", "Listing fees", "Featured placements", "Advertising"],
    products_services: [
      "Marketplace platform",
      "Payment processing",
      "Dispute resolution",
      "Seller tools",
    ],
  },
  retail: {
    description:
      "Physical or omnichannel retail business selling products through stores and/or online channels.",
    goals: [
      "Increase foot traffic 20%",
      "Achieve $200 average basket size",
      "Reach 90% inventory accuracy",
      "Grow loyalty program to 5,000 members",
    ],
    customer_segments: [
      "Local residents",
      "Tourists",
      "Loyal repeat customers",
      "Online-to-store shoppers",
    ],
    value_propositions: [
      "In-store experience",
      "Expert staff advice",
      "Immediate availability",
      "Local convenience",
    ],
    revenue_streams: ["In-store sales", "Online sales", "Loyalty program", "Gift cards"],
    products_services: [
      "Retail products",
      "Personal shopping",
      "Gift wrapping",
      "Delivery service",
    ],
  },
  other: {
    description: "",
    goals: ["Define primary business objective", "Establish revenue targets"],
    customer_segments: ["Target customer segment"],
    value_propositions: ["Core value proposition"],
    revenue_streams: ["Primary revenue stream"],
    products_services: ["Core product or service"],
  },
};
