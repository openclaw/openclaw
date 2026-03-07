import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import CookieConsent, { shouldEnableAnalytics } from "@/components/CookieConsent";
import { analytics } from "@/lib/posthog";
import ScrollToTop from "@/components/ScrollToTop";
import FloatingFeedback from "@/components/FloatingFeedback";
import Landing from "@/pages/landing";
import AppPage from "@/pages/app";
import Terms from "@/pages/terms";
import Privacy from "@/pages/privacy";
import ThankYou from "@/pages/thank-you";
import Support from "@/pages/SupportPage";
import BlogIndex from "@/pages/BlogIndex";
import BlogPost from "@/pages/BlogPost";

import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import ReferralPage from "@/pages/ReferralPage";

import ProfilePage from "@/pages/profile";
import AddPaymentMethodPage from "@/pages/add-payment-method";
import SubscriptionPage from "@/pages/subscription";

import ReferralsPage from "@/pages/referrals";
import LegalPage from "@/pages/legal";

import NotFound from "@/pages/not-found";

function Router() {
  // Debug: Log current path
  if (typeof window !== 'undefined') {
    console.log('🧭 Current path:', window.location.pathname);
  }

  return (
    <>
      <ScrollToTop />
      <FloatingFeedback />
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/app" component={AppPage} />
        <Route path="/terms" component={Terms} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/thank-you" component={ThankYou} />
        <Route path="/support" component={Support} />
        <Route path="/blog" component={BlogIndex} />
        <Route path="/blog/:slug" component={BlogPost} />

        <Route path="/login" component={Login} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/app/dashboard" component={Dashboard} />
        <Route path="/profile" component={ProfilePage} />
        <Route path="/app/profile" component={ProfilePage} />
        <Route path="/app/add-payment-method" component={AddPaymentMethodPage} />
        <Route path="/app/subscription" component={SubscriptionPage} />
        <Route path="/app/subscription/success" component={SubscriptionPage} />

        <Route path="/app/referrals" component={ReferralsPage} />
        <Route path="/app/legal" component={LegalPage} />
        <Route path="/referrals" component={ReferralsPage} />
        <Route path="/legal" component={LegalPage} />

        <Route path="/referral/:code" component={ReferralPage} />

        <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  const handleAnalyticsConsent = () => {
    analytics.enableAnalytics();
    console.log('📊 Analytics consent granted - PostHog tracking enabled');
  };

  const handleAnalyticsDecline = () => {
    analytics.disableAnalytics();
    console.log('🔒 Analytics consent declined - tracking disabled');
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
        <CookieConsent 
          onAccept={handleAnalyticsConsent}
          onDecline={handleAnalyticsDecline}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
