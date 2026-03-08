import type {
  VentureModule,
  VentureValidationResult,
} from "../../venture-core/src/module-contract.js";
import type { VentureResult } from "../../venture-core/src/result-schema.js";
import type { VentureRunContext } from "../../venture-core/src/run-context.js";
import type { VentureModuleDescriptor } from "../../venture-core/src/types.js";

export type FunnelBuilderInput = {
  offerName: string;
  audience: string;
  channel: "telegram" | "email" | "web" | "multi";
  goal: "lead-gen" | "checkout" | "book-call";
  hasUpsell?: boolean;
};

export type FunnelBuilderPlan = {
  offerName: string;
  audience: string;
  channel: FunnelBuilderInput["channel"];
  goal: FunnelBuilderInput["goal"];
  hasUpsell: boolean;
};

export type FunnelStage = {
  id: string;
  type: "landing" | "checkout" | "book-call" | "upsell" | "confirmation" | "email-sequence";
  name: string;
  objective: string;
};

export type FunnelBuilderOutput = {
  blueprintName: string;
  stages: FunnelStage[];
};

const descriptor: VentureModuleDescriptor = {
  id: "funnel-builder",
  version: "0.1.0",
  title: "Funnel Builder",
  description: "Generates funnel blueprints for offers and audience/channel goals.",
  capabilities: ["funnel-design", "campaign-structure"],
};

export const funnelBuilderModule: VentureModule<
  FunnelBuilderInput,
  FunnelBuilderPlan,
  FunnelBuilderOutput
> = {
  descriptor,
  async plan(input: FunnelBuilderInput, ctx: VentureRunContext): Promise<FunnelBuilderPlan> {
    const plan = {
      offerName: input.offerName.trim(),
      audience: input.audience.trim(),
      channel: input.channel,
      goal: input.goal,
      hasUpsell: input.hasUpsell === true,
    };
    ctx.logger.info("funnel-builder: plan created", {
      runId: ctx.runId,
      offerName: plan.offerName,
      goal: plan.goal,
      channel: plan.channel,
    });
    return plan;
  },
  async execute(plan: FunnelBuilderPlan): Promise<FunnelBuilderOutput> {
    const stages: FunnelStage[] = [
      {
        id: "landing",
        type: "landing",
        name: "Landing Page",
        objective: `Capture intent from ${plan.audience}`,
      },
    ];

    if (plan.goal === "checkout") {
      stages.push({
        id: "checkout",
        type: "checkout",
        name: "Checkout",
        objective: "Convert buyer intent into payment",
      });
    } else if (plan.goal === "book-call") {
      stages.push({
        id: "book-call",
        type: "book-call",
        name: "Call Booking",
        objective: "Book qualified sales conversation",
      });
    }

    if (plan.hasUpsell) {
      stages.push({
        id: "upsell",
        type: "upsell",
        name: "Upsell Offer",
        objective: "Increase AOV with relevant post-conversion offer",
      });
    }

    stages.push({
      id: "confirmation",
      type: "confirmation",
      name: "Confirmation",
      objective: "Confirm conversion and set next expectation",
    });
    stages.push({
      id: "email-sequence",
      type: "email-sequence",
      name: "Follow-up Sequence",
      objective: "Nurture or reactivate leads",
    });

    return {
      blueprintName: `${plan.offerName} :: ${plan.goal} funnel`,
      stages,
    };
  },
  async validate(output: FunnelBuilderOutput): Promise<VentureValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!output.blueprintName) {
      errors.push("blueprint_name_missing");
    }
    const hasLanding = output.stages.some((s) => s.type === "landing");
    const hasConfirmation = output.stages.some((s) => s.type === "confirmation");
    if (!hasLanding) {
      errors.push("landing_stage_missing");
    }
    if (!hasConfirmation) {
      errors.push("confirmation_stage_missing");
    }
    if (output.stages.length < 3) {
      warnings.push("funnel_too_short");
    }
    return { ok: errors.length === 0, errors, warnings };
  },
  async report(
    output: FunnelBuilderOutput,
    validation: VentureValidationResult,
    ctx: VentureRunContext,
  ): Promise<VentureResult> {
    return {
      ok: validation.ok,
      summary: validation.ok
        ? `Generated funnel blueprint "${output.blueprintName}" with ${output.stages.length} stages.`
        : "Funnel blueprint validation failed.",
      metrics: [{ key: "stage_count", value: output.stages.length }],
      artifacts: [],
      events: [
        {
          ts: ctx.nowIso(),
          level: validation.ok ? "info" : "warn",
          message: "funnel_builder_report_generated",
          fields: { runId: ctx.runId, blueprint: output.blueprintName },
        },
      ],
      warnings: validation.warnings,
      errors: validation.errors,
    };
  },
};

