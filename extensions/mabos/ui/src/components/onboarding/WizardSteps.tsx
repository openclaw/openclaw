import { useMutation } from "@tanstack/react-query";
import {
  Star,
  DollarSign,
  Settings,
  Megaphone,
  Terminal,
  Heart,
  Scale,
  Compass,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  AlertCircle,
  Rocket,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";

// ---------- Types ----------

type OnboardingFormData = {
  business_id: string;
  name: string;
  type: string;
  description: string;
  legal_name: string;
  jurisdiction: string;
  stage: "mvp" | "growth" | "scale";
};

type OnboardResult = {
  ok: boolean;
  business_id: string;
  agents_created: string[];
};

// ---------- Constants ----------

const STEPS = ["Business Info", "Details", "Agents", "Review", "Launch"] as const;

const BUSINESS_TYPES = [
  { value: "ecommerce", label: "E-Commerce" },
  { value: "saas", label: "SaaS" },
  { value: "consulting", label: "Consulting" },
  { value: "retail", label: "Retail" },
  { value: "agency", label: "Agency" },
];

const STAGES: { value: OnboardingFormData["stage"]; label: string; desc: string }[] = [
  { value: "mvp", label: "MVP", desc: "Early stage, validating product-market fit" },
  { value: "growth", label: "Growth", desc: "Scaling revenue and customer base" },
  { value: "scale", label: "Scale", desc: "Optimizing operations at scale" },
];

const CORE_AGENTS: { role: string; icon: LucideIcon; description: string }[] = [
  { role: "CEO", icon: Star, description: "Strategic leadership and decision coordination" },
  { role: "CFO", icon: DollarSign, description: "Financial planning, budgets, and reporting" },
  { role: "COO", icon: Settings, description: "Operations management and process optimization" },
  { role: "CMO", icon: Megaphone, description: "Marketing strategy and campaign oversight" },
  { role: "CTO", icon: Terminal, description: "Technology architecture and engineering" },
  { role: "HR", icon: Heart, description: "Workforce management and talent operations" },
  { role: "Legal", icon: Scale, description: "Compliance, contracts, and legal advisory" },
  { role: "Strategy", icon: Compass, description: "Market analysis and strategic planning" },
  { role: "Knowledge", icon: BookOpen, description: "Organizational knowledge and documentation" },
];

const BUSINESS_ID_REGEX = /^[a-zA-Z0-9_-]*$/;

// ---------- Helpers ----------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function isValidBusinessId(id: string): boolean {
  return BUSINESS_ID_REGEX.test(id) && id.length > 0 && id.length <= 64;
}

// ---------- Step Indicator ----------

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEPS.map((label, i) => {
        const isActive = i === currentStep;
        const isCompleted = i < currentStep;
        return (
          <div key={label} className="flex items-center">
            {/* Connecting line before */}
            {i > 0 && (
              <div
                className="h-px w-8 sm:w-12"
                style={{
                  backgroundColor: isCompleted ? "var(--accent-green)" : "var(--border-mabos)",
                }}
              />
            )}
            {/* Step dot + label */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors"
                style={{
                  backgroundColor: isCompleted
                    ? "var(--accent-green)"
                    : isActive
                      ? "var(--accent-purple)"
                      : "var(--bg-tertiary)",
                  color: isCompleted || isActive ? "#ffffff" : "var(--text-muted)",
                }}
              >
                {isCompleted ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              <span
                className="text-[10px] sm:text-xs whitespace-nowrap"
                style={{
                  color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                }}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Step 1: Business Info ----------

function StepBusinessInfo({
  data,
  onChange,
}: {
  data: OnboardingFormData;
  onChange: (patch: Partial<OnboardingFormData>) => void;
}) {
  const [idEdited, setIdEdited] = useState(false);

  function handleNameChange(name: string) {
    const patch: Partial<OnboardingFormData> = { name };
    if (!idEdited) {
      patch.business_id = slugify(name);
    }
    onChange(patch);
  }

  const idValid = data.business_id.length === 0 || isValidBusinessId(data.business_id);

  return (
    <div className="space-y-6">
      {/* Business Name */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">
          Business Name <span className="text-[var(--accent-red)]">*</span>
        </label>
        <Input
          placeholder="e.g. Acme Corporation"
          value={data.name}
          onChange={(e) => handleNameChange(e.target.value)}
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      {/* Business ID */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">
          Business ID <span className="text-[var(--accent-red)]">*</span>
        </label>
        <Input
          placeholder="auto-generated-from-name"
          value={data.business_id}
          onChange={(e) => {
            setIdEdited(true);
            onChange({ business_id: e.target.value });
          }}
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono text-sm"
        />
        {!idValid && (
          <p className="text-xs text-[var(--accent-red)]">
            Only alphanumeric characters, hyphens, and underscores allowed (max 64 chars)
          </p>
        )}
        <p className="text-xs text-[var(--text-muted)]">
          Alphanumeric, hyphens, and underscores only. Auto-generated from name.
        </p>
      </div>

      {/* Business Type */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">
          Business Type <span className="text-[var(--accent-red)]">*</span>
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {BUSINESS_TYPES.map((bt) => (
            <button
              key={bt.value}
              type="button"
              onClick={() => onChange({ type: bt.value })}
              className="px-4 py-2.5 rounded-lg text-sm font-medium transition-colors border"
              style={{
                backgroundColor:
                  data.type === bt.value
                    ? "color-mix(in srgb, var(--accent-purple) 20%, var(--bg-secondary))"
                    : "var(--bg-secondary)",
                borderColor:
                  data.type === bt.value ? "var(--accent-purple)" : "var(--border-mabos)",
                color: data.type === bt.value ? "var(--accent-purple)" : "var(--text-secondary)",
              }}
            >
              {bt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">Description</label>
        <textarea
          placeholder="Brief description of your business..."
          value={data.description}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={3}
          className="w-full rounded-md border px-3 py-2 text-sm bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-purple)]/50 resize-none"
        />
      </div>
    </div>
  );
}

// ---------- Step 2: Details ----------

function StepDetails({
  data,
  onChange,
}: {
  data: OnboardingFormData;
  onChange: (patch: Partial<OnboardingFormData>) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Legal Name */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">Legal Name</label>
        <Input
          placeholder={data.name || "Defaults to business name"}
          value={data.legal_name}
          onChange={(e) => onChange({ legal_name: e.target.value })}
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
        <p className="text-xs text-[var(--text-muted)]">
          Official legal entity name. Defaults to business name if left blank.
        </p>
      </div>

      {/* Jurisdiction */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--text-primary)]">Jurisdiction</label>
        <Input
          placeholder="e.g. Delaware, USA"
          value={data.jurisdiction}
          onChange={(e) => onChange({ jurisdiction: e.target.value })}
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      {/* Stage */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-[var(--text-primary)]">Business Stage</label>
        <div className="space-y-2">
          {STAGES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange({ stage: s.value })}
              className="w-full flex items-center gap-4 p-4 rounded-lg border transition-colors text-left"
              style={{
                backgroundColor:
                  data.stage === s.value
                    ? "color-mix(in srgb, var(--accent-green) 10%, var(--bg-secondary))"
                    : "var(--bg-secondary)",
                borderColor: data.stage === s.value ? "var(--accent-green)" : "var(--border-mabos)",
              }}
            >
              <div
                className="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0"
                style={{
                  borderColor: data.stage === s.value ? "var(--accent-green)" : "var(--text-muted)",
                }}
              >
                {data.stage === s.value && (
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: "var(--accent-green)" }}
                  />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{s.label}</p>
                <p className="text-xs text-[var(--text-muted)]">{s.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Step 3: Agent Preview ----------

function StepAgentPreview() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        The following 9 core AI agents will be created to manage your business:
      </p>
      <div className="grid gap-3">
        {CORE_AGENTS.map((agent) => {
          const Icon = agent.icon;
          return (
            <div
              key={agent.role}
              className="flex items-center gap-4 p-3 rounded-lg border border-[var(--border-mabos)] bg-[var(--bg-secondary)]"
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, var(--bg-card))",
                }}
              >
                <Icon className="w-5 h-5 text-[var(--accent-purple)]" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">{agent.role}</p>
                <p className="text-xs text-[var(--text-muted)] truncate">{agent.description}</p>
              </div>
              <Badge className="ml-auto shrink-0 bg-[var(--accent-green)]/10 text-[var(--accent-green)] border-[var(--accent-green)]/20">
                Auto
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Step 4: Review ----------

function StepReview({
  data,
  onJumpTo,
}: {
  data: OnboardingFormData;
  onJumpTo: (step: number) => void;
}) {
  const requiredMissing = !data.name.trim() || !data.business_id.trim() || !data.type;

  return (
    <div className="space-y-6">
      {requiredMissing && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-[color-mix(in_srgb,var(--accent-orange)_10%,var(--bg-card))] border border-[var(--accent-orange)]/20">
          <AlertCircle className="w-4 h-4 text-[var(--accent-orange)] shrink-0" />
          <p className="text-sm text-[var(--accent-orange)]">
            Please fill in all required fields before launching.
          </p>
        </div>
      )}

      {/* Business Info section */}
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)]">
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm text-[var(--text-primary)]">Business Info</CardTitle>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onJumpTo(0)}
              className="text-[var(--accent-purple)] hover:text-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/10"
            >
              <Pencil className="w-3 h-3 mr-1" />
              Edit
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[var(--text-muted)] text-xs">Name</p>
              <p className="text-[var(--text-primary)]">
                {data.name || <span className="text-[var(--accent-red)]">Required</span>}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)] text-xs">ID</p>
              <p className="text-[var(--text-primary)] font-mono text-xs">
                {data.business_id || <span className="text-[var(--accent-red)]">Required</span>}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)] text-xs">Type</p>
              <p className="text-[var(--text-primary)]">
                {BUSINESS_TYPES.find((bt) => bt.value === data.type)?.label || (
                  <span className="text-[var(--accent-red)]">Required</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)] text-xs">Description</p>
              <p className="text-[var(--text-primary)] truncate">
                {data.description || <span className="text-[var(--text-muted)]">--</span>}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Details section */}
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)]">
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm text-[var(--text-primary)]">Details</CardTitle>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onJumpTo(1)}
              className="text-[var(--accent-purple)] hover:text-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/10"
            >
              <Pencil className="w-3 h-3 mr-1" />
              Edit
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[var(--text-muted)] text-xs">Legal Name</p>
              <p className="text-[var(--text-primary)]">
                {data.legal_name || data.name || (
                  <span className="text-[var(--text-muted)]">--</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)] text-xs">Jurisdiction</p>
              <p className="text-[var(--text-primary)]">
                {data.jurisdiction || <span className="text-[var(--text-muted)]">--</span>}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)] text-xs">Stage</p>
              <p className="text-[var(--text-primary)]">
                {STAGES.find((s) => s.value === data.stage)?.label ?? "MVP"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agents count */}
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)]">
        <CardHeader className="pb-0">
          <CardTitle className="text-sm text-[var(--text-primary)]">Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--text-secondary)]">
            <span className="text-[var(--accent-green)] font-bold">{CORE_AGENTS.length}</span> core
            agents will be created automatically.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Step 5: Launch ----------

function StepLaunch({
  data,
  result,
  error,
  isPending,
  onSubmit,
  onRetry,
}: {
  data: OnboardingFormData;
  result: OnboardResult | null;
  error: string | null;
  isPending: boolean;
  onSubmit: () => void;
  onRetry: () => void;
}) {
  // Success state
  if (result) {
    return (
      <div className="flex flex-col items-center text-center space-y-6 py-4">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))",
          }}
        >
          <Check className="w-8 h-8 text-[var(--accent-green)]" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-bold text-[var(--text-primary)]">Business Launched!</h3>
          <p className="text-sm text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{data.name}</span> has been
            successfully onboarded.
          </p>
        </div>
        <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] w-full">
          <CardContent className="pt-6">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">Business ID</span>
                <span className="font-mono text-[var(--text-primary)]">{result.business_id}</span>
              </div>
              <Separator className="bg-[var(--border-mabos)]" />
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">Agents Created</span>
                <span className="text-[var(--accent-green)] font-bold">
                  {result.agents_created.length}
                </span>
              </div>
              <Separator className="bg-[var(--border-mabos)]" />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {result.agents_created.map((agent) => (
                  <Badge
                    key={agent}
                    className="bg-[var(--accent-purple)]/10 text-[var(--accent-purple)] border-[var(--accent-purple)]/20 text-xs"
                  >
                    {agent}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center text-center space-y-6 py-4">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-red) 15%, var(--bg-card))",
          }}
        >
          <AlertCircle className="w-8 h-8 text-[var(--accent-red)]" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-bold text-[var(--text-primary)]">Onboarding Failed</h3>
          <p className="text-sm text-[var(--accent-red)]">{error}</p>
        </div>
        <Button
          onClick={onRetry}
          className="bg-[var(--accent-red)] hover:bg-[var(--accent-red)]/80 text-white"
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // Ready to submit
  return (
    <div className="flex flex-col items-center text-center space-y-6 py-4">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{
          backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, var(--bg-card))",
        }}
      >
        <Rocket className="w-8 h-8 text-[var(--accent-purple)]" />
      </div>
      <div className="space-y-2">
        <h3 className="text-xl font-bold text-[var(--text-primary)]">Ready to Launch</h3>
        <p className="text-sm text-[var(--text-secondary)]">
          Everything looks good. Click below to create{" "}
          <span className="font-medium text-[var(--text-primary)]">{data.name}</span> and provision{" "}
          {CORE_AGENTS.length} AI agents.
        </p>
      </div>
      <Button
        onClick={onSubmit}
        disabled={isPending}
        className="bg-[var(--accent-green)] hover:bg-[var(--accent-green)]/80 text-black font-semibold px-8 h-11"
      >
        {isPending ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Launching...
          </>
        ) : (
          <>
            <Rocket className="w-4 h-4 mr-2" />
            Launch Business
          </>
        )}
      </Button>
    </div>
  );
}

// ---------- Main WizardSteps ----------

export function WizardSteps() {
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<OnboardingFormData>({
    business_id: "",
    name: "",
    type: "",
    description: "",
    legal_name: "",
    jurisdiction: "",
    stage: "mvp",
  });

  const mutation = useMutation({
    mutationFn: () => api.onboard(buildPayload()),
  });

  function buildPayload() {
    const payload: Record<string, string> = {
      business_id: formData.business_id.trim(),
      name: formData.name.trim(),
      type: formData.type,
    };
    if (formData.legal_name.trim()) payload.legal_name = formData.legal_name.trim();
    if (formData.description.trim()) payload.description = formData.description.trim();
    if (formData.jurisdiction.trim()) payload.jurisdiction = formData.jurisdiction.trim();
    if (formData.stage) payload.stage = formData.stage;
    return payload;
  }

  function updateFormData(patch: Partial<OnboardingFormData>) {
    setFormData((prev) => ({ ...prev, ...patch }));
  }

  const canGoNext = (() => {
    if (step === 0) {
      return (
        formData.name.trim().length > 0 &&
        isValidBusinessId(formData.business_id) &&
        formData.type.length > 0
      );
    }
    return true;
  })();

  const isLastNavStep = step === 3; // step 4 (Review) is the last navigable step before Launch
  const isLaunchStep = step === 4;

  function handleNext() {
    if (step < STEPS.length - 1) setStep(step + 1);
  }

  function handleBack() {
    if (step > 0) setStep(step - 1);
  }

  function handleJumpTo(target: number) {
    setStep(target);
  }

  function handleSubmit() {
    mutation.mutate();
  }

  function handleRetry() {
    mutation.reset();
  }

  // Extract result/error from mutation
  const mutResult = mutation.data as OnboardResult | undefined;
  const mutError = mutation.error ? (mutation.error as Error).message : null;

  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)]">
      <CardContent className="pt-6">
        {/* Step Indicator */}
        <StepIndicator currentStep={step} />

        {/* Step Content */}
        <div className="min-h-[360px]">
          {step === 0 && <StepBusinessInfo data={formData} onChange={updateFormData} />}
          {step === 1 && <StepDetails data={formData} onChange={updateFormData} />}
          {step === 2 && <StepAgentPreview />}
          {step === 3 && <StepReview data={formData} onJumpTo={handleJumpTo} />}
          {step === 4 && (
            <StepLaunch
              data={formData}
              result={mutResult ?? null}
              error={mutError}
              isPending={mutation.isPending}
              onSubmit={handleSubmit}
              onRetry={handleRetry}
            />
          )}
        </div>

        {/* Navigation */}
        {!isLaunchStep && (
          <>
            <Separator className="bg-[var(--border-mabos)] my-6" />
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={step === 0}
                className="border-[var(--border-mabos)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={!canGoNext}
                className="bg-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/80 text-white"
              >
                {isLastNavStep ? "Launch" : "Next"}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
