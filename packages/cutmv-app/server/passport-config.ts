/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Passport OAuth Configuration
 * Google & Microsoft OAuth 2.0 authentication strategies
 */

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as MicrosoftStrategy } from 'passport-microsoft';
import { authService } from './auth-service';

// Configure Google OAuth Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback',
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          console.log('🔐 Google OAuth callback received:', {
            profileId: profile.id,
            email: profile.emails?.[0]?.value,
            name: profile.displayName,
          });

          // Get email from Google profile
          const email = profile.emails?.[0]?.value;
          if (!email) {
            console.error('❌ No email provided by Google');
            return done(new Error('No email provided by Google'));
          }

          // Check for referral code in state (if passed during auth initiation)
          const referralCode = (req.query.state as string) || undefined;

          // Get or create user (reuse existing auth service method)
          const user = await authService.getOrCreateUser(email, referralCode);
          console.log('✅ User authenticated via Google:', user.email);

          // Update user name if not set and Google provides one
          if (!user.name && profile.displayName) {
            await authService.updateUserProfile(user.id, {
              name: profile.displayName,
            });
            console.log('✅ Updated user name from Google profile:', profile.displayName);
          }

          return done(null, user);
        } catch (error) {
          console.error('❌ Google OAuth error:', error);
          return done(error instanceof Error ? error : new Error('OAuth authentication failed'));
        }
      }
    )
  );

  console.log('✅ Google OAuth strategy configured');
} else {
  console.warn('⚠️ Google OAuth not configured - missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
}

// Configure Microsoft OAuth Strategy
if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
  passport.use(
    new MicrosoftStrategy(
      {
        clientID: process.env.MICROSOFT_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
        callbackURL: process.env.MICROSOFT_CALLBACK_URL || '/api/auth/microsoft/callback',
        scope: ['user.read'],
        tenant: process.env.MICROSOFT_TENANT_ID || 'common',
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          console.log('🔐 Microsoft OAuth callback received:', {
            profileId: profile.id,
            email: profile.emails?.[0]?.value,
            name: profile.displayName,
          });

          // Get email from Microsoft profile
          const email = profile.emails?.[0]?.value;
          if (!email) {
            console.error('❌ No email provided by Microsoft');
            return done(new Error('No email provided by Microsoft'));
          }

          // Check for referral code in state
          const referralCode = (req.query.state as string) || undefined;

          // Get or create user
          const user = await authService.getOrCreateUser(email, referralCode);
          console.log('✅ User authenticated via Microsoft:', user.email);

          // Update user name if not set
          if (!user.name && profile.displayName) {
            await authService.updateUserProfile(user.id, {
              name: profile.displayName,
            });
            console.log('✅ Updated user name from Microsoft profile:', profile.displayName);
          }

          return done(null, user);
        } catch (error) {
          console.error('❌ Microsoft OAuth error:', error);
          return done(error instanceof Error ? error : new Error('OAuth authentication failed'));
        }
      }
    )
  );

  console.log('✅ Microsoft OAuth strategy configured');
} else {
  console.warn('⚠️ Microsoft OAuth not configured - missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET');
}

// Passport serialization (not needed for stateless session, but required by passport)
passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    // Not actively used since we use token-based sessions
    done(null, { id });
  } catch (error) {
    done(error);
  }
});

export default passport;
