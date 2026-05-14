// Keep the bundled setup entry imports narrow so setup loads do not pull in
// the full DingTalk runtime (Stream client, message handler, etc.).
//
// The connector reuses the same `dingtalkPlugin` definition for setup; it
// already exposes the `setup` adapter and `setupWizard` (`dingtalkOnboardingAdapter`)
// fields, and only the lightweight onboarding modules will load from here.
export { dingtalkPlugin as dingtalkSetupPlugin } from "./src/channel.js";
