# 5-Year Compound Interest Quantitative Model
 # Theoretical Calculation: 100,000 → 1,200,000,000 CNY
 # For learning & demonstration only, NOT investment advice
 def calculate_compound(principal, target, years):
     r = (target / principal) ** (1 / years) - 1
     balance = principal
     result = []
     for y in range(1, years + 1):
         balance *= (1 + r)
         result.append(round(balance, 2))
     return r, result
 if __name__ == "__main__":
     principal = 100000.0
     target = 1200000000.0
     years = 5
     r, yearly = calculate_compound(principal, target, years)
     print("=== 5-Year Compound Interest Model ===")
     print(f"Principal: {principal:,.0f} CNY")
     print(f"Target: {target:,.0f} CNY")
     print(f"Required annual return: {r*100:.2f}%")
     print("-------------------------------------")
     for i, val in enumerate(yearly, 1):
         print(f"Year {i}: {val:,.2f} CNY")
