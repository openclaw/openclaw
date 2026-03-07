/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Footer Component
 * Site footer with navigation and auth links
 */

import { Link } from 'wouter';
import { useAuth } from "@/hooks/useAuth";
import fdLogo from "@/assets/fd-logo.png";

export default function Footer() {
  const { user, isAuthenticated } = useAuth();

  return (
    <footer className="bg-neutral-900 text-white py-12 border-t border-neutral-700 mt-16">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center space-x-3 mb-4">
              <div className="w-8 h-8 bg-brand-green rounded-full flex items-center justify-center">
                <span className="text-brand-black font-bold text-sm">C</span>
              </div>
              <span className="text-xl font-bold">CUTMV</span>
            </div>
            <p className="text-sm text-neutral-400 mb-4">
              AI-powered video editing for music creators
            </p>
            <div className="flex items-center space-x-2">
              <span className="text-xs text-neutral-500">Powered by</span>
              <img src={fdLogo} alt="Full Digital" className="h-4 opacity-60" />
            </div>
          </div>

          {/* Product */}
          <div>
            <h3 className="font-semibold mb-4 text-neutral-200">Product</h3>
            <ul className="space-y-2 text-sm">
              <li><Link href="/blog" className="text-neutral-400 hover:text-white transition-colors">Blog</Link></li>
              <li><Link href="/support" className="text-neutral-400 hover:text-white transition-colors">Support</Link></li>
              {isAuthenticated && user && (
                <li><Link href="/dashboard" className="text-neutral-400 hover:text-white transition-colors">Dashboard</Link></li>
              )}
            </ul>
          </div>

          {/* Account */}
          <div>
            <h3 className="font-semibold mb-4 text-neutral-200">Account</h3>
            <ul className="space-y-2 text-sm">
              {isAuthenticated && user ? (
                <>
                  <li>
                    <Link href="/dashboard" className="text-neutral-400 hover:text-white transition-colors">
                      My Exports
                    </Link>
                  </li>
                  <li>
                    <span className="text-neutral-500 text-xs">
                      Logged in as {user.email}
                    </span>
                  </li>
                </>
              ) : (
                <li>
                  <Link href="/login" className="text-brand-green hover:text-brand-green-light transition-colors">
                    Login / Sign Up
                  </Link>
                </li>
              )}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-semibold mb-4 text-neutral-200">Legal</h3>
            <ul className="space-y-2 text-sm">
              <li><Link href="/terms" className="text-neutral-400 hover:text-white transition-colors">Terms of Service</Link></li>
              <li><Link href="/privacy" className="text-neutral-400 hover:text-white transition-colors">Privacy Policy</Link></li>
              <li>
                <button
                  onClick={() => {
                    // Trigger cookie consent modal
                    localStorage.removeItem('cutmv-cookie-consent');
                    window.location.reload();
                  }}
                  className="text-neutral-400 hover:text-white transition-colors text-left"
                >
                  Cookie Settings
                </button>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom section */}
        <div className="mt-8 pt-8 border-t border-neutral-700 flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
          <p className="text-xs text-neutral-500">
            © 2026 Full Digital LLC. All rights reserved.
          </p>
          <div className="flex items-center space-x-4 text-xs text-neutral-500">
            <span>Made with 🤍 for creators</span>
          </div>
        </div>
      </div>
    </footer>
  );
}