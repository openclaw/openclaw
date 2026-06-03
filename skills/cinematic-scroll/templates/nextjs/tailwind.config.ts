import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Fluid type scale — pairs with --fluid-* CSS vars in globals.css
      fontSize: {
        'fluid-eyebrow': ['var(--fluid-eyebrow)', { lineHeight: '1.4', letterSpacing: '0.18em' }],
        'fluid-body': ['var(--fluid-body)', { lineHeight: '1.55' }],
        'fluid-headline': ['var(--fluid-headline)', { lineHeight: '1.02', letterSpacing: '-0.025em' }],
        'fluid-display': ['var(--fluid-display)', { lineHeight: '0.92', letterSpacing: '-0.045em' }],
      },
      screens: {
        // Standard sm/md/lg/xl/2xl plus tall-phone + tablet-portrait helpers
        xs: '420px',
        'ipad-portrait': { raw: '(min-width: 768px) and (max-width: 1024px) and (orientation: portrait)' },
      },
      colors: {
        ink: '#0b0907',
      },
      boxShadow: {
        'glow-sm': '0 0 24px rgba(255,255,255,0.08)',
      },
    },
  },
  plugins: [],
};

export default config;
