# Gateway Pattern Templates

## Gateway Interface (ABC)

```python
# domain/gateway/user_gateway.py
from abc import ABC, abstractmethod
from typing import List, Optional
from domain.user.entity import User

class UserGateway(ABC):
    """User Gateway Interface - Defined in Domain layer"""
    
    @abstractmethod
    def save(self, user: User) -> None:
        pass
    
    @abstractmethod
    def get_by_id(self, user_id: str) -> Optional[User]:
        pass
    
    @abstractmethod
    def exists_by_email(self, email: str) -> bool:
        pass
    
    @abstractmethod
    def list_by_condition(self, keyword: str = None, page: int = 1, size: int = 10) -> List[User]:
        pass
```

## Gateway Implementation

```python
# infrastructure/gateway_impl/user_gateway_impl.py
from typing import List, Optional
from domain.gateway.user_gateway import UserGateway
from domain.user.entity import User
from infrastructure.convertor.user_convertor import UserConvertor
from infrastructure.repository.models import UserDO, db

class UserGatewayImpl(UserGateway):
    def __init__(self):
        self.convertor = UserConvertor()
    
    def save(self, user: User) -> None:
        user_do = self.convertor.to_data_object(user)
        db.session.add(user_do)
        db.session.commit()
    
    def get_by_id(self, user_id: str) -> Optional[User]:
        user_do = UserDO.query.get(user_id)
        return self.convertor.to_domain(user_do) if user_do else None
    
    def exists_by_email(self, email: str) -> bool:
        return UserDO.query.filter_by(email=email).count() > 0
    
    def list_by_condition(self, keyword: str = None, page: int = 1, size: int = 10) -> List[User]:
        query = UserDO.query
        if keyword:
            query = query.filter(UserDO.name.contains(keyword))
        user_dos = query.offset((page - 1) * size).limit(size).all()
        return [self.convertor.to_domain(do) for do in user_dos]
```

## Convertor

```python
# infrastructure/convertor/user_convertor.py
from domain.user.entity import User
from client.dto.co.user_co import UserCO
from infrastructure.repository.models import UserDO

class UserConvertor:
    def to_data_object(self, user: User) -> UserDO:
        return UserDO(id=user.id, name=user.name, email=user.email, status=user.status)
    
    def to_domain(self, user_do: UserDO) -> User:
        return User(id=user_do.id, name=user_do.name, email=user_do.email, status=user_do.status)
    
    def to_client_object(self, user: User) -> UserCO:
        return UserCO(id=user.id, name=user.name, email=user.email, status=user.status)
```

## Domain Entity

```python
# domain/user/entity.py
from dataclasses import dataclass, field
import uuid

@dataclass
class User:
    name: str
    email: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "active"
    
    def activate(self) -> None:
        if self.status == "inactive":
            self.status = "active"
    
    def deactivate(self) -> None:
        self.status = "inactive"
```
