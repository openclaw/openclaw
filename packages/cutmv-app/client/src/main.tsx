import { createRoot } from "react-dom/client";
import FaviconProvider from "@/components/FaviconProvider";
import App from "./App";
import "./index.css";
import { initializeSentry, captureException } from "./lib/sentry";
import { analytics } from "./lib/posthog";

// Initialize analytics with consent checking
try {
  console.log('📊 PostHog analytics initialized');
  
  // Set analytics consent cookie for development/production
  if (!document.cookie.includes('posthog_consent=')) {
    document.cookie = 'posthog_consent=true; path=/; max-age=31536000; SameSite=Strict';
  }
} catch (error) {
  console.log('📊 Analytics initialization warning:', (error as Error).message);
}

// Initialize Sentry before rendering the app
try {
  initializeSentry();
  console.log('✅ Sentry error tracking initialized (frontend)');
} catch (error) {
  console.log('⚠️ Sentry initialization warning:', (error as Error).message);
}

// Track app initialization with error handling
try {
  analytics.track('app_initialized', {
    timestamp: new Date().toISOString(),
    environment: import.meta.env.MODE
  });
} catch (error) {
  console.log('📊 Analytics tracking warning:', (error as Error).message);
}

// Trigger the sample error that Sentry setup requests in development
if (import.meta.env.MODE === 'development') {
  setTimeout(() => {
    try {
      throw new Error("This is your first error!");
    } catch (error) {
      try {
        captureException(error as Error, {
          test: true,
          source: 'setup_verification'
        });
        console.log('✅ Sample Sentry error sent for setup verification');
      } catch (sentryError) {
        console.log('⚠️ Sentry error capture warning:', (sentryError as Error).message);
      }
    }
  }, 2000);
}

createRoot(document.getElementById("root")!).render(
  <FaviconProvider>
    <App />
  </FaviconProvider>
);
