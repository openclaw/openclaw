/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Header Component
 * Navigation header with authentication controls
 */

import { Link } from 'wouter';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { User, LogOut, Video } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import fdLogo from "@/assets/fd-logo.png";

interface HeaderProps {
  bgColor?: string;
}

export default function Header({ bgColor = "bg-black" }: HeaderProps) {
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    window.location.href = '/';
  };

  return (
    <header className={`${bgColor} text-white py-4 sticky top-0 z-50 border-b border-gray-800`}>
      <div className="container mx-auto px-6 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
            <div className="flex items-center space-x-2">
              <img src={fdLogo} alt="Full Digital" className="h-8 w-8" />
              <div className="flex flex-col">
                <div className="flex items-center space-x-2">
                  <span className="text-2xl font-bold">CUTMV</span>
                  <Badge variant="outline" className="bg-brand-green/10 text-brand-green border-brand-green/30 font-medium text-xs px-2 py-1">
                    BETA
                  </Badge>
                </div>
                <span className="text-xs text-gray-400 mt-1">AI-POWERED MUSIC VIDEO CUT DOWN TOOL</span>
              </div>
            </div>
          </Link>
        </div>

        <nav className="hidden md:flex items-center space-x-6">
          <Link href="/blog" className="text-gray-300 hover:text-white transition-colors">
            Blog
          </Link>
          <Link href="/support" className="text-gray-300 hover:text-white transition-colors">
            Support
          </Link>
          
          {!isLoading && (
            <>
              {isAuthenticated && user ? (
                <div className="flex items-center space-x-4">
                  <Link href="/dashboard">
                    <Button 
                      size="sm" 
                      className="text-black font-medium hover:opacity-90"
                      style={{ backgroundColor: 'hsl(85, 70%, 55%)', borderColor: 'hsl(85, 70%, 55%)' }}
                    >
                      <Video className="w-4 h-4 mr-2" />
                      Dashboard
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLogout}
                    className="text-gray-400 hover:text-white"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <Link href="/login">
                  <Button className="bg-brand-green hover:bg-brand-green-light text-brand-black font-medium" size="sm">
                    <User className="w-4 h-4 mr-2" />
                    Login
                  </Button>
                </Link>
              )}
            </>
          )}
        </nav>

        {/* Mobile menu */}
        <div className="md:hidden">
          {!isLoading && (
            <>
              {isAuthenticated && user ? (
                <div className="flex items-center space-x-2">
                  <Link href="/dashboard">
                    <Button 
                      size="sm" 
                      className="text-black font-medium"
                      style={{ backgroundColor: 'hsl(85, 70%, 55%)', borderColor: 'hsl(85, 70%, 55%)' }}
                    >
                      <Video className="w-4 h-4" />
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLogout}
                    className="text-gray-400 hover:text-white"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <Link href="/login">
                  <Button className="bg-brand-green hover:bg-brand-green-light text-brand-black font-medium" size="sm">
                    <User className="w-4 h-4" />
                  </Button>
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </header>
  );
}