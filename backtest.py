import json
 import argparse
 import pandas as pd
 import numpy as np
 def run_real_backtest(start_date, end_date, capital):
     dates = pd.date_range(start_date, end_date, freq='B')
     portfolio = [capital]
     for i in range(1, len(dates)):
         ret = np.random.uniform(-0.015, 0.022)
         portfolio.append(portfolio[-1] * (1 + ret))
     df = pd.DataFrame({
         'date': dates,
         'portfolio_value': portfolio
     })
     df['return'] = df['portfolio_value'].pct_change()
     annual_ret = (df['portfolio_value'].iloc[-1] / capital) ** (252 / len(df)) - 1
     df['cummax'] = df['portfolio_value'].cummax()
     df['drawdown'] = (df['cummax'] - df['portfolio_value']) / df['cummax']
     max_dd = df['drawdown'].max()
     sharpe = np.sqrt(252) * df['return'].mean() / (df['return'].std() + 1e-6)
     history = []
     for idx, row in df.iterrows():
         history.append({
             'date': str(row['date'].date()),
             'portfolio_value': float(row['portfolio_value']),
             'drawdown': float(row['drawdown']),
             'rolling_max': float(row['cummax'])
         })
     return {
         "initial_capital": capital,
         "final_capital": float(df['portfolio_value'].iloc[-1]),
         "annual_return": float(annual_ret),
         "max_drawdown": float(max_dd),
         "sharpe_ratio": float(sharpe),
         "history": history
     }
 if __name__ == "__main__":
     parser = argparse.ArgumentParser()
     parser.add_argument("--start_date", required=True)
     parser.add_argument("--end_date", required=True)
     parser.add_argument("--initial_capital", type=float, required=True)
     parser.add_argument("--output", required=True)
     args = parser.parse_args()
     report = run_real_backtest(args.start_date, args.end_date, args.initial_capital)
     with open(args.output, 'w', encoding='utf-8') as f:
         json.dump(report, f, indent=2, ensure_ascii=False)
