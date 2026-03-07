/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Promo Code Management Service
 * Proprietary software - unauthorized use prohibited
 */

interface PromoCode {
  code: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number; // Percentage (e.g., 20 for 20%) or fixed amount in cents
  expirationDate: Date;
  usageLimit: number; // Total uses allowed
  usageCount: number; // Current usage count
  userLimit: number; // Uses per user/email (usually 1)
  userUsage: Record<string, number>; // Track usage per email
  isActive: boolean;
  description?: string;
  createdAt: Date;
}

class PromoCodeService {
  private promoCodes: Map<string, PromoCode> = new Map();

  constructor() {
    this.initializeDefaultCodes();
  }

  private initializeDefaultCodes(): void {
    // Staff code - only active promo code
    this.addPromoCode({
      code: 'STAFF25',
      discountType: 'percentage',
      discountValue: 100, // 100% off
      expirationDate: new Date('2025-12-31'),
      usageLimit: 1000,
      userLimit: 10, // Allow staff to use multiple times
      description: 'Staff testing code - 100% off'
    });

    console.log('✅ Promo code initialized: STAFF25 only');
  }

  addPromoCode(codeData: Omit<PromoCode, 'usageCount' | 'userUsage' | 'isActive' | 'createdAt'>): boolean {
    const promoCode: PromoCode = {
      ...codeData,
      code: codeData.code.toUpperCase(),
      usageCount: 0,
      userUsage: {},
      isActive: true,
      createdAt: new Date()
    };

    this.promoCodes.set(promoCode.code, promoCode);
    console.log(`✅ Promo code added: ${promoCode.code} (${promoCode.discountValue}${promoCode.discountType === 'percentage' ? '%' : ' cents'} off)`);
    return true;
  }

  validatePromoCode(code: string, email: string, orderAmount: number): {
    isValid: boolean;
    discount: number;
    finalAmount: number;
    message: string;
  } {
    const upperCode = code.toUpperCase();
    const promoCode = this.promoCodes.get(upperCode);

    // Code doesn't exist
    if (!promoCode) {
      return {
        isValid: false,
        discount: 0,
        finalAmount: orderAmount,
        message: 'Invalid promo code'
      };
    }

    // Code is inactive
    if (!promoCode.isActive) {
      return {
        isValid: false,
        discount: 0,
        finalAmount: orderAmount,
        message: 'Promo code is no longer active'
      };
    }

    // Code is expired
    if (new Date() > promoCode.expirationDate) {
      return {
        isValid: false,
        discount: 0,
        finalAmount: orderAmount,
        message: 'Promo code has expired'
      };
    }

    // Global usage limit exceeded
    if (promoCode.usageCount >= promoCode.usageLimit) {
      return {
        isValid: false,
        discount: 0,
        finalAmount: orderAmount,
        message: 'Promo code usage limit reached'
      };
    }

    // User usage limit exceeded
    const userUsageCount = promoCode.userUsage[email] || 0;
    if (userUsageCount >= promoCode.userLimit) {
      return {
        isValid: false,
        discount: 0,
        finalAmount: orderAmount,
        message: 'You have already used this promo code'
      };
    }

    // Calculate discount
    let discount = 0;
    if (promoCode.discountType === 'percentage') {
      discount = Math.round((orderAmount * promoCode.discountValue) / 100);
    } else {
      discount = promoCode.discountValue;
    }

    // Ensure discount doesn't exceed order amount
    discount = Math.min(discount, orderAmount);
    const finalAmount = Math.max(0, orderAmount - discount);

    return {
      isValid: true,
      discount,
      finalAmount,
      message: `${promoCode.discountValue}${promoCode.discountType === 'percentage' ? '%' : ' cent'} discount applied`
    };
  }

  applyPromoCode(code: string, email: string, orderAmount: number): {
    success: boolean;
    discount: number;
    finalAmount: number;
    message: string;
  } {
    const validation = this.validatePromoCode(code, email, orderAmount);
    
    if (!validation.isValid) {
      return {
        success: false,
        discount: 0,
        finalAmount: orderAmount,
        message: validation.message
      };
    }

    const upperCode = code.toUpperCase();
    const promoCode = this.promoCodes.get(upperCode)!;

    // Record usage
    promoCode.usageCount++;
    promoCode.userUsage[email] = (promoCode.userUsage[email] || 0) + 1;

    console.log(`✅ Promo code applied: ${upperCode} for ${email} (${validation.discount} cents off)`);

    return {
      success: true,
      discount: validation.discount,
      finalAmount: validation.finalAmount,
      message: validation.message
    };
  }

  getPromoCodeInfo(code: string): PromoCode | null {
    return this.promoCodes.get(code.toUpperCase()) || null;
  }

  listActiveCodes(): PromoCode[] {
    return Array.from(this.promoCodes.values()).filter(code => 
      code.isActive && new Date() <= code.expirationDate
    );
  }

  deactivateCode(code: string): boolean {
    const promoCode = this.promoCodes.get(code.toUpperCase());
    if (promoCode) {
      promoCode.isActive = false;
      console.log(`✅ Promo code deactivated: ${code}`);
      return true;
    }
    return false;
  }

  getUsageStats(code: string): {
    totalUsage: number;
    usageLimit: number;
    uniqueUsers: number;
    remainingUses: number;
  } | null {
    const promoCode = this.promoCodes.get(code.toUpperCase());
    if (!promoCode) {return null;}

    return {
      totalUsage: promoCode.usageCount,
      usageLimit: promoCode.usageLimit,
      uniqueUsers: Object.keys(promoCode.userUsage).length,
      remainingUses: promoCode.usageLimit - promoCode.usageCount
    };
  }
}

// Export singleton instance
export const promoCodeService = new PromoCodeService();
export default promoCodeService;