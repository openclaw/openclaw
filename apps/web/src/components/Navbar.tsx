"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";

export default function Navbar() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { role?: string })?.role === "admin";

  return (
    <nav>
      <div className="inner">
        <Link href="/" className="logo">
          🦞 <span>OpenClaw</span>
        </Link>
        <div className="links">
          <Link href="/pricing" className="btn btn-ghost">Pricing</Link>
          {session ? (
            <>
              <Link href="/dashboard" className="btn btn-ghost">Dashboard</Link>
              {isAdmin && (
                <Link href="/admin" className="btn btn-ghost" style={{ color: "#e05a2b" }}>Admin</Link>
              )}
              <button className="btn btn-outline" onClick={() => signOut({ callbackUrl: "/" })}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost">Sign in</Link>
              <Link href="/register" className="btn btn-primary">Get started</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
