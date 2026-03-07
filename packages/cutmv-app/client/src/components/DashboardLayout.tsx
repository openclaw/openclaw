/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Dashboard Layout with Persistent Navigation
 * Unified navigation system for all authenticated dashboard pages
 */

import { useState, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { 
  Video, 
  User, 
  Settings, 
  Users, 
  History, 
  FileText, 
  LogOut,
  Menu,
  Sparkles,
  Home,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { cn } from '@/lib/utils';
import fdLogo from '@/assets/fd-logo.png';

interface DashboardLayoutProps {
  children: React.ReactNode;
  currentUser?: {
    email: string;
    id: string;
  } | null;
  onLogout?: () => void;
}

const navigationItems = [
  {
    name: 'Tool',
    href: '/app',
    icon: Video,
    description: 'Create video content',
    primary: true
  },
  {
    name: 'Dashboard',
    href: '/dashboard',
    icon: Home,
    description: 'Export history & overview'
  }
];

const settingsItems = [
  {
    name: 'Profile',
    href: '/profile',
    icon: User,
    description: 'Account settings'
  },
  {
    name: 'Referrals',
    href: '/referrals',
    icon: Users,
    description: 'Earn credits'  
  },
  {
    name: 'Legal',
    href: '/legal',
    icon: FileText,
    description: 'Terms & Privacy'
  }
];

function SidebarContent({ currentUser, onLogout }: { currentUser?: DashboardLayoutProps['currentUser'], onLogout?: () => void }) {
  const [location] = useLocation();
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  
  // Check if any settings page is active to auto-expand
  const isSettingsPageActive = settingsItems.some(item => 
    location === item.href || location.startsWith(item.href)
  );
  
  // Auto-expand if on settings page
  useEffect(() => {
    if (isSettingsPageActive) {
      setSettingsExpanded(true);
    }
  }, [isSettingsPageActive]);

  return (
    <div className="flex flex-col h-full bg-brand-black text-white">
      {/* Header */}
      <div className="p-6 border-b border-gray-800">
        <Link href="/" className="flex items-center space-x-3 mb-4 hover:opacity-80 transition-opacity">
          <img src={fdLogo} alt="Full Digital" className="h-8 w-8" />
          <div>
            <h2 className="text-xl font-bold text-brand-green">CUTMV</h2>
            <div className="flex items-center space-x-1 text-xs text-gray-400">
              <Sparkles className="w-3 h-3" />
              <span>AI-POWERED</span>
            </div>
          </div>
        </Link>
        
        {currentUser && (
          <div className="text-sm">
            <div className="text-gray-300 truncate">{currentUser.email}</div>
            <div className="text-xs text-gray-500">ID: {currentUser.id.slice(0, 8)}...</div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2">
        {/* Main navigation items */}
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href || (item.href !== '/app' && location.startsWith(item.href));
          
          return (
            <Link key={item.name} href={item.href}>
              <div
                className={cn(
                  "flex items-center space-x-3 px-3 py-2 rounded-lg transition-all duration-200 group cursor-pointer",
                  isActive 
                    ? "bg-brand-green text-brand-black" 
                    : "text-gray-300 hover:bg-gray-800 hover:text-white",
                  item.primary && "ring-1 ring-brand-green/30"
                )}
                onClick={() => window.scrollTo(0, 0)}
              >
                <Icon className={cn(
                  "w-5 h-5 flex-shrink-0",
                  isActive ? "text-brand-black" : "text-gray-400 group-hover:text-brand-green"
                )} />
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    "font-medium",
                    isActive ? "text-brand-black" : "text-gray-300 group-hover:text-white"
                  )}>
                    {item.name}
                  </div>
                  <div className={cn(
                    "text-xs",
                    isActive ? "text-brand-black/70" : "text-gray-500 group-hover:text-gray-400"
                  )}>
                    {item.description}
                  </div>
                </div>
                {item.primary && (
                  <ChevronRight className={cn(
                    "w-4 h-4",
                    isActive ? "text-brand-black" : "text-brand-green"
                  )} />
                )}
              </div>
            </Link>
          );
        })}
        
        {/* Settings Section */}
        <div className="space-y-1">
          <button
            onClick={() => setSettingsExpanded(!settingsExpanded)}
            className={cn(
              "w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition-all duration-200 group cursor-pointer",
              (settingsExpanded || isSettingsPageActive) ? "bg-gray-800 text-white" : "text-gray-300 hover:bg-gray-800 hover:text-white"
            )}
          >
            <Settings className={cn(
              "w-5 h-5 flex-shrink-0",
              (settingsExpanded || isSettingsPageActive) ? "text-brand-green" : "text-gray-400 group-hover:text-brand-green"
            )} />
            <div className="flex-1 min-w-0 text-left">
              <div className={cn(
                "font-medium",
                (settingsExpanded || isSettingsPageActive) ? "text-white" : "text-gray-300 group-hover:text-white"
              )}>
                Settings
              </div>
              <div className={cn(
                "text-xs",
                (settingsExpanded || isSettingsPageActive) ? "text-gray-400" : "text-gray-500 group-hover:text-gray-400"
              )}>
                Account & preferences
              </div>
            </div>
            {(settingsExpanded || isSettingsPageActive) ? (
              <ChevronDown className="w-4 h-4 text-gray-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-400" />
            )}
          </button>
          
          {/* Settings Submenu */}
          {(settingsExpanded || isSettingsPageActive) && (
            <div className="ml-8 space-y-1">
              {settingsItems.map((item) => {
                const Icon = item.icon;
                const isActive = location === item.href || (item.href !== '/app' && location.startsWith(item.href));
                
                return (
                  <Link key={item.name} href={item.href}>
                    <div
                      className={cn(
                        "flex items-center space-x-3 px-3 py-2 rounded-lg transition-all duration-200 group cursor-pointer",
                        isActive 
                          ? "bg-brand-green text-brand-black" 
                          : "text-gray-400 hover:bg-gray-700 hover:text-white"
                      )}
                      onClick={() => window.scrollTo(0, 0)}
                    >
                      <Icon className={cn(
                        "w-4 h-4 flex-shrink-0",
                        isActive ? "text-brand-black" : "text-gray-500 group-hover:text-brand-green"
                      )} />
                      <div className="flex-1 min-w-0">
                        <div className={cn(
                          "font-medium text-sm",
                          isActive ? "text-brand-black" : "text-gray-400 group-hover:text-white"
                        )}>
                          {item.name}
                        </div>
                        <div className={cn(
                          "text-xs",
                          isActive ? "text-brand-black/70" : "text-gray-600 group-hover:text-gray-400"
                        )}>
                          {item.description}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-800">
        <Button
          onClick={onLogout}
          variant="outline"
          size="sm"
          className="w-full text-gray-300 border-gray-600 hover:bg-gray-800 hover:text-white"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Log Out
        </Button>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children, currentUser, onLogout }: DashboardLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex">
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex lg:w-72 lg:flex-col lg:fixed lg:inset-y-0 z-50">
        <SidebarContent currentUser={currentUser} onLogout={onLogout} />
      </div>

      {/* Mobile Navigation */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetTrigger asChild className="lg:hidden">
          <Button
            variant="outline"
            size="sm"
            className="fixed top-4 left-4 z-40 bg-brand-black text-white border-gray-600"
          >
            <Menu className="w-4 h-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-72">
          <SidebarContent currentUser={currentUser} onLogout={onLogout} />
        </SheetContent>
      </Sheet>

      {/* Main Content */}
      <div className="lg:ml-72 flex-1 flex flex-col min-w-0">
        <main className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}