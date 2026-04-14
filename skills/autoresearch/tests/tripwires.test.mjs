import { describe, it, expect } from 'vitest';
import { checkLength, checkStuffing, checkDrift } from '../lib/tripwires.mjs';

describe('tripwires', () => {
  describe('checkLength', () => {
    it('rejects under 50 chars', () => {
      expect(checkLength('short')).toEqual({ ok: false, reason: 'too_short' });
    });
    it('rejects over 500 chars', () => {
      expect(checkLength('x'.repeat(501))).toEqual({ ok: false, reason: 'too_long' });
    });
    it('accepts 50-500', () => {
      expect(checkLength('y'.repeat(100))).toEqual({ ok: true });
    });
  });

  describe('checkStuffing', () => {
    it('flags same word ≥5 times', () => {
      const desc = 'email email email email email for sending messages and other tasks on the system';
      expect(checkStuffing(desc).ok).toBe(false);
    });
    it('passes normal text', () => {
      const desc = 'Send email via Gmail with attachments and labels and threads and recipients';
      expect(checkStuffing(desc).ok).toBe(true);
    });
  });

  describe('checkDrift', () => {
    it('passes identical strings (similarity = 1.0)', () => {
      const r = checkDrift('send email messages fast', 'send email messages fast');
      expect(r.ok).toBe(true);
      expect(r.similarity).toBeCloseTo(1.0, 2);
    });
    it('flags very different strings (similarity < 0.5)', () => {
      const r = checkDrift('email gmail inbox messages', 'weather forecast sunshine clouds');
      expect(r.ok).toBe(false);
      expect(r.similarity).toBeLessThan(0.5);
    });
  });
});
