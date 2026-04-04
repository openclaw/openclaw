import { type NextRequest, NextResponse } from 'next/server'

// Middleware for Supabase session management
export async function middleware(request: NextRequest) {
  // Skip Supabase if env vars not configured (build-time, local dev without .env)
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return NextResponse.next()
  }
  const { updateSession } = await import('./utils/supabase/middleware')
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
