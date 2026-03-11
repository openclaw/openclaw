import { Rocket } from "lucide-react";
import { WizardSteps } from "@/components/onboarding/WizardSteps";

export function OnboardingPage() {
  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--accent-purple) 15%, var(--bg-card))",
          }}
        >
          <Rocket className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            Business Onboarding
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">
            Set up a new AI-powered business in 5 easy steps
          </p>
        </div>
      </div>

      {/* Wizard */}
      <WizardSteps />
    </div>
  );
}
