import mysql.connector
from mysql.connector import Error
from mysql.connector import errorcode, pooling
import time
import random
import logging
import pandas as pd
from typing import List, Dict, Any, Optional

# Database configuration
db_config = {
    "host": "123.57.81.67",
    "port": 3306,
    "user": "report",
    "password": "rcT(g!*KyI4NEmUT",
    "database": "superworker"
}
db_config_phpmyadmin = {
    "host": "192.168.3.100",
    "port": 3306,
    "user": "mysql",
    "password": "mysql144000",
    "database": "superworker"
}

class DatabaseManager:
    """MySQL连接管理：使用连接池 + 指数退避，避免 1129 连接风暴"""

    _pools = {}

    def __init__(self, use_phpmyadmin=False, pool_size: int = 3, pool_name: str | None = None):
        self.connection = None
        self.cursor = None
        self.use_phpmyadmin = use_phpmyadmin
        self.pool_size = pool_size
        self.pool_name = pool_name or ("phpmyadmin_pool" if use_phpmyadmin else "main_db_pool")
        self.logger = logging.getLogger(__name__)
    
    def _get_or_create_pool(self):
        key = (self.pool_name, self.use_phpmyadmin)
        if key in DatabaseManager._pools:
            return DatabaseManager._pools[key]
        config = db_config_phpmyadmin if self.use_phpmyadmin else db_config
        pool = pooling.MySQLConnectionPool(
            pool_name=self.pool_name,
            pool_size=self.pool_size,
            autocommit=False,
            connection_timeout=30,  # 增加连接超时时间
            pool_reset_session=True,  # 重置会话状态
            **config
        )
        DatabaseManager._pools[key] = pool
        return pool

    def connect(self, max_retries: int = 5, base_delay: float = 0.5, max_delay: float = 10.0) -> bool:
        """从连接池获取连接，带指数退避。对 1129 直接返回失败并提示 FLUSH HOSTS。"""
        attempt = 0
        pool_exhausted_retries = 0  # 连接池耗尽的连续重试计数
        while attempt <= max_retries:
            try:
                pool = self._get_or_create_pool()
                
                # 检查连接池状态
                try:
                    pool_size = pool.pool_size
                    # 注意：MySQL连接池没有直接的方法获取当前使用连接数
                    # 这里我们通过尝试获取连接来检测池状态
                except:
                    pass
                
                self.connection = pool.get_connection()
                if self.connection.is_connected():
                    self.cursor = self.connection.cursor()
                    db_name = "phpMyAdmin" if self.use_phpmyadmin else "主数据库"
                    self.logger.info(f"Connected to {db_name} MySQL Server {self.connection.get_server_info()}")
                    return True
            except Error as e:
                attempt += 1
                error_msg = str(e)
                
                # 检查是否是连接池耗尽错误
                if "pool exhausted" in error_msg.lower() or "too many connections" in error_msg.lower():
                    pool_exhausted_retries += 1
                    self.logger.warning(f"连接池耗尽 (attempt {attempt}/{max_retries}, exhausted_retries={pool_exhausted_retries}): {e}")
                    if pool_exhausted_retries < 3:
                        # 前 2 次（累计不足 3 次）采取更长时间退避重试
                        delay = min(max_delay * 2, base_delay * (2 ** (attempt - 1)) * 3)
                        delay *= (0.8 + 0.4 * random.random())
                        print(f"连接池耗尽，等待 {delay:.2f}s 后重试...")
                        time.sleep(delay)
                        continue
                    else:
                        # 第 3 次仍然耗尽：断开并清理连接池后再尝试重新连接
                        try:
                            self.disconnect()
                        except Exception:
                            pass
                        try:
                            key = (self.pool_name, self.use_phpmyadmin)
                            DatabaseManager._pools.pop(key, None)
                            self.logger.warning("已清理连接池缓存，准备重新创建连接池后再连接")
                        except Exception:
                            pass
                        # 重置计数并稍作等待后继续下一轮获取新池并连接
                        pool_exhausted_retries = 0
                        delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
                        delay *= (0.8 + 0.4 * random.random())
                        time.sleep(delay)
                        continue
                
                if getattr(e, 'errno', None) == errorcode.ER_HOST_IS_BLOCKED:  # 1129
                    self.logger.error("MySQL host blocked (1129). Please run FLUSH HOSTS on server.")
                    time.sleep(min(max_delay, 15.0))
                    return False
                if attempt > max_retries:
                    print(f"Error connecting to MySQL (exceeded retries): {e}")
                    return False
                delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
                delay *= (0.8 + 0.4 * random.random())
                print(f"Error connecting to MySQL (attempt {attempt}/{max_retries}): {e}. Retry in {delay:.2f}s")
                time.sleep(delay)
            except Exception as e:
                attempt += 1
                if attempt > max_retries:
                    print(f"Unexpected error connecting to MySQL: {e}")
                    return False
                delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
                delay *= (0.8 + 0.4 * random.random())
                time.sleep(delay)
        return False
    
    def disconnect(self):
        """Disconnect from the database"""
        try:
            if self.cursor:
                # Consume any unread results
                try:
                    self.cursor.fetchall()
                except:
                    pass
                self.cursor.close()
                self.cursor = None
            if self.connection:
                try:
                    if self.connection.is_connected():
                        self.connection.close()
                        print("MySQL connection closed")
                except:
                    pass
                self.connection = None
        except Exception as e:
            print(f"Error during disconnect: {e}")
    
    def execute_query(self, query: str, params: Optional[tuple] = None) -> Optional[List]:
        """Execute a query and return results"""
        try:
            if self.cursor is None:
                print("No database connection, attempting to reconnect...")
                if not self.connect():
                    print("Failed to reconnect to database")
                    return []
            
            # 清理之前的结果
            try:
                while self.cursor.nextset():
                    pass
            except:
                pass
            
            try:
                self.cursor.fetchall()
            except:
                pass
                
            if params:
                self.cursor.execute(query, params)
            else:
                self.cursor.execute(query)
            
            if query.strip().upper().startswith(('SELECT', 'DESCRIBE', 'SHOW')):
                result = self.cursor.fetchall()
                return result
            else:
                if self.connection:
                    self.connection.commit()
                return []  # 返回空列表而不是None
        except Error as e:
            # 连接丢失重试一次
            if getattr(e, 'errno', None) in (errorcode.CR_SERVER_LOST, errorcode.CR_SERVER_GONE_ERROR):
                try:
                    self.disconnect()
                except Exception:
                    pass
                if self.connect():
                    try:
                        if params:
                            self.cursor.execute(query, params)
                        else:
                            self.cursor.execute(query)
                        if query.strip().upper().startswith(('SELECT', 'DESCRIBE', 'SHOW')):
                            return self.cursor.fetchall()
                        else:
                            if self.connection:
                                self.connection.commit()
                            return []
                    except Error as e2:
                        print(f"Error executing query after reconnect: {e2}")
                        return []
            print(f"Error executing query: {e}")
            return []
        except Exception as e:
            print(f"Unexpected error executing query: {e}")
            return []
    
    def execute_update(self, query: str, params: Optional[tuple] = None) -> int:
        """Execute an update/insert/delete query and return affected rows"""
        try:
            if self.cursor is None:
                print("No database connection")
                return 0
            
            # 清理之前的结果
            try:
                while self.cursor.nextset():
                    pass
            except:
                pass
            
            try:
                self.cursor.fetchall()
            except:
                pass
                
            if params:
                affected_rows = self.cursor.execute(query, params)
            else:
                affected_rows = self.cursor.execute(query)
            
            if self.connection:
                self.connection.commit()
            
            return affected_rows if affected_rows else self.cursor.rowcount
            
        except Error as e:
            if getattr(e, 'errno', None) in (errorcode.CR_SERVER_LOST, errorcode.CR_SERVER_GONE_ERROR):
                try:
                    self.disconnect()
                except Exception:
                    pass
                if self.connect():
                    try:
                        if params:
                            affected_rows = self.cursor.execute(query, params)
                        else:
                            affected_rows = self.cursor.execute(query)
                        if self.connection:
                            self.connection.commit()
                        return affected_rows if affected_rows else self.cursor.rowcount
                    except Error as e2:
                        print(f"Error executing update after reconnect: {e2}")
                        return 0
            print(f"Error executing update: {e}")
            return 0
        except Exception as e:
            print(f"Unexpected error executing update: {e}")
            return 0

    def lastrowid(self) -> Optional[int]:
        """Get last inserted row id if available"""
        try:
            if self.cursor is not None and hasattr(self.cursor, "lastrowid"):
                return self.cursor.lastrowid
        except Exception:
            pass
        return None
    
    def get_table_info(self, table_name: str) -> Dict[str, Any]:
        """Get information about a specific table"""
        try:
            if self.cursor is None:
                print("No database connection")
                return {}
                
            # Get table structure
            self.cursor.execute(f"DESCRIBE {table_name}")
            columns = self.cursor.fetchall()
            
            # Get row count
            self.cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
            result = self.cursor.fetchone()
            row_count = result[0] if result else 0
            
            return {
                'table_name': table_name,
                'columns': columns,
                'row_count': row_count
            }
        except Error as e:
            print(f"Error getting table info: {e}")
            return {}
    
    def get_table_data(self, table_name: str, limit: int = 10) -> pd.DataFrame:
        """Get data from a table as a pandas DataFrame"""
        try:
            query = f"SELECT * FROM {table_name} LIMIT {limit}"
            df = pd.read_sql(query, self.connection)
            return df
        except Error as e:
            print(f"Error getting table data: {e}")
            return pd.DataFrame()
    
    def list_tables(self) -> List[str]:
        """List all tables in the database"""
        try:
            if self.cursor is None:
                print("No database connection")
                return []
                
            self.cursor.execute("SHOW TABLES")
            tables_result = self.cursor.fetchall()
            tables = [str(table[0]) for table in tables_result]
            return tables
        except Error as e:
            print(f"Error listing tables: {e}")
            return []

    def get_table_columns_with_comments(self, table_name: str) -> List[Dict[str, str]]:
        """Get table columns with their comments/descriptions"""
        try:
            if self.cursor is None:
                print("No database connection")
                return []
                
            query = """
                SELECT 
                    COLUMN_NAME,
                    COLUMN_COMMENT,
                    DATA_TYPE,
                    IS_NULLABLE,
                    COLUMN_DEFAULT
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                ORDER BY ORDINAL_POSITION
            """
            
            self.cursor.execute(query, (db_config['database'], table_name))
            columns = self.cursor.fetchall()
            
            column_info = []
            for col in columns:
                column_name = col[0]
                comment = col[1] if col[1] else column_name  # Use column name if no comment
                data_type = col[2]
                is_nullable = col[3]
                default_value = col[4]
                
                column_info.append({
                    'name': column_name,
                    'display_name': comment,  # Use comment as display name
                    'data_type': data_type,
                    'is_nullable': is_nullable,
                    'default_value': default_value
                })
            
            return column_info
        except Error as e:
            print(f"Error getting column comments: {e}")
            return []

def main():
    """Main function to demonstrate database operations"""
    db = DatabaseManager()
    
    if db.connect():
        print("\n=== Database Connection Successful ===")
        
        # List all tables
        tables = db.list_tables()
        print(f"\nTotal tables in database: {len(tables)}")
        
        # Show some example table information
        if tables:
            print(f"\nExample table: {tables[0]}")
            table_info = db.get_table_info(tables[0])
            if table_info:
                print(f"Columns: {len(table_info['columns'])}")
                print(f"Row count: {table_info['row_count']}")
                
                # Show first few rows
                df = db.get_table_data(tables[0], limit=5)
                if not df.empty:
                    print(f"\nFirst 5 rows of {tables[0]}:")
                    print(df.head())
        
        db.disconnect()

if __name__ == "__main__":
    main() 